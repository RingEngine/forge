import crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { compileFilterSourceFilesWithDiagnostics } from '@ring-engine-org/filter-compiler-core';
import { createNodeShaderCompiler } from '@ring-engine-org/filter-compiler-core/glslang-node';
import { packFilterPackage } from '@ring-engine-org/filter-packer';

const VIEW_ID = 'forge.sidebar';
const OUTPUT_CHANNEL = 'Forge';
const CURRENT_FILTER_KEY = 'forge.currentFilterRoot';
const SECRET_MASTER_KEY = 'forge.masterKey';
const SECRET_PRIVATE_KEY = 'forge.privateKey';
const PUBLIC_KEY_KEY = 'forge.publicKey';
const PRESET_PREVIEW_INPUTS = {
  image: {
    label: 'Default Image',
    mediaType: 'image/jpeg',
    path: ['resources', 'presets', 'default-image.jpg']
  },
  video: {
    label: 'Default Video',
    mediaType: 'video/mp4',
    path: ['resources', 'presets', 'default-video.mp4']
  }
};
const TEXT_FILE_EXTENSIONS = new Set([
  '.json',
  '.lua',
  '.glsl',
  '.vert',
  '.frag',
  '.comp',
  '.md',
  '.txt',
  '.yaml',
  '.yml'
]);

let extensionState = null;

export async function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  const diagnostics = vscode.languages.createDiagnosticCollection('forge');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  statusBar.command = 'forge.runPreview';
  context.subscriptions.push(output, diagnostics, statusBar);

  const projects = new ProjectManager(context, output);
  const sidebar = new ForgeSidebarProvider(context, projects, output, diagnostics);
  const settings = new ForgeSettingsPanel(context);
  const runner = new ForgeCommands(context, projects, sidebar, settings, output, diagnostics, statusBar);

  extensionState = { projects, sidebar, runner, settings };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('forge.refreshProjects', async () => {
      await projects.refresh();
      await sidebar.update();
      runner.updateStatusBar();
    }),
    vscode.commands.registerCommand('forge.runPreview', () => runner.runPreview()),
    vscode.commands.registerCommand('forge.exportRpf', () => runner.exportRpf()),
    vscode.commands.registerCommand('forge.openSettings', () => settings.show()),
    vscode.commands.registerCommand('forge.showSidebar', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.forge');
      try {
        await vscode.commands.executeCommand('forge.sidebar.focus');
      } catch {
        // VS Code creates view focus commands lazily; opening the container is enough as a fallback.
      }
    })
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async () => {
    await projects.selectProjectForActiveEditor();
    await sidebar.update();
    runner.updateStatusBar();
  }));

  await projects.refresh();
  await projects.selectProjectForActiveEditor();
  await sidebar.update();
  runner.updateStatusBar();
}

export function deactivate() {
  extensionState = null;
}

class ProjectManager {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.projects = [];
    this.currentRoot = context.workspaceState.get(CURRENT_FILTER_KEY, '');
  }

  async refresh() {
    this.projects = await discoverFilterProjects(this.output);
    if (!this.projects.some((project) => project.rootUri.toString() === this.currentRoot)) {
      this.currentRoot = '';
      if (this.projects.length > 0) {
        this.currentRoot = this.projects[0].rootUri.toString();
      }
      await this.persistCurrentRoot();
    }
    this.output.appendLine(`Discovered ${this.projects.length} filter project(s).`);
    return this.projects;
  }

  getCurrentProject() {
    return this.projects.find((project) => project.rootUri.toString() === this.currentRoot)
      ?? (this.projects.length === 1 ? this.projects[0] : null);
  }

  async setCurrentProject(root) {
    if (!this.projects.some((project) => project.rootUri.toString() === root)) return;
    this.currentRoot = root;
    await this.persistCurrentRoot();
  }

  async selectProjectForActiveEditor() {
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    if (!activeUri || activeUri.scheme !== 'file') return;
    const match = findProjectContainingUri(this.projects, activeUri);
    if (!match || match.rootUri.toString() === this.currentRoot) return;
    this.currentRoot = match.rootUri.toString();
    await this.persistCurrentRoot();
  }

  async persistCurrentRoot() {
    await this.context.workspaceState.update(CURRENT_FILTER_KEY, this.currentRoot || undefined);
  }
}

class ForgeCommands {
  constructor(context, projects, sidebar, settings, output, diagnostics, statusBar) {
    this.context = context;
    this.projects = projects;
    this.sidebar = sidebar;
    this.settings = settings;
    this.output = output;
    this.diagnostics = diagnostics;
    this.statusBar = statusBar;
    this.shaderCompilerPromise = null;
  }

  updateStatusBar(status = '') {
    const current = this.projects.getCurrentProject();
    if (!current) {
      this.statusBar.text = 'Forge: no filter';
      this.statusBar.tooltip = 'No filter project selected.';
      this.statusBar.show();
      return;
    }
    this.statusBar.text = `Forge: ${current.name || path.basename(current.rootUri.fsPath)}${status ? ` | ${status}` : ''}`;
    this.statusBar.tooltip = current.rootUri.fsPath;
    this.statusBar.show();
  }

  async runPreview() {
    const project = await this.requireCurrentProject();
    if (!project) return;

    this.output.show(true);
    this.output.appendLine(`Run Preview: ${project.rootUri.fsPath}`);
    this.updateStatusBar('Running');
    await this.sidebar.setStatus('Saving filter files...');

    try {
      const savedDocuments = await saveDirtyProjectDocuments(project.rootUri);
      if (savedDocuments.length > 0) {
        this.output.appendLine(`Saved ${savedDocuments.length} dirty project file(s) before preview compile.`);
      }
      await this.sidebar.setStatus('Running preview compile...');
      const files = await readFilterProjectFiles(project.rootUri);
      const compiler = await this.getShaderCompiler();
      const result = await compileFilterSourceFilesWithDiagnostics(files, {
        backend: 'web-preview',
        compiler,
        sourceName: project.name || path.basename(project.rootUri.fsPath)
      });
      this.publishDiagnostics(project, result.diagnostics);
      const compiledManifest = parseJsonFile(result.files['manifest.json']);
      await this.sidebar.setPreviewResult({
        ok: true,
        projectRoot: project.rootUri.toString(),
        manifest: compiledManifest,
        diagnostics: result.diagnostics,
        outputFiles: Object.keys(result.files).filter((key) => !key.startsWith('__')),
        compiledFiles: serializeFileMap(result.files),
        sourceFiles: serializeFileMap(files)
      });
      this.output.appendLine(`Preview compile OK: ${Object.keys(result.files).length} output file(s).`);
      this.updateStatusBar('Preview OK');
    } catch (error) {
      this.publishErrorDiagnostic(project, error);
      await revealProblemsView();
      await this.sidebar.setPreviewResult({
        ok: false,
        error: error?.message || String(error)
      });
      this.output.appendLine(`Preview failed: ${error?.message || error}`);
      this.updateStatusBar('Preview failed');
    }
  }

  async unloadPreview() {
    this.output.appendLine('Unload Preview.');
    this.diagnostics.clear();
    this.sidebar.clearRuntimeDiagnostic();
    await this.sidebar.unloadPreview();
    this.updateStatusBar('Unloaded');
  }

  async exportRpf() {
    const project = await this.requireCurrentProject();
    if (!project) return;

    const masterKey = await this.context.secrets.get(SECRET_MASTER_KEY);
    if (!masterKey) {
      await vscode.window.showWarningMessage('Configure a master key before exporting RFP.', 'Open Settings')
        .then((choice) => choice === 'Open Settings' ? this.settings.show() : null);
      return;
    }

    this.output.show(true);
    this.output.appendLine(`Export RFP: ${project.rootUri.fsPath}`);
    this.updateStatusBar('Exporting');
    await this.sidebar.setStatus('Exporting RFP...');

    try {
      const files = await readFilterProjectFiles(project.rootUri);
      const compiler = await this.getShaderCompiler();
      const result = await compileFilterSourceFilesWithDiagnostics(files, {
        compiler,
        sourceName: project.name || path.basename(project.rootUri.fsPath)
      });
      this.publishDiagnostics(project, result.diagnostics);

      const privateKey = await this.context.secrets.get(SECRET_PRIVATE_KEY);
      const packageBytes = await packFilterPackage({
        masterKey,
        privateKey: privateKey || null,
        files: result.files
      });
      const saveUri = await chooseRpfSaveUri(project);
      if (!saveUri) {
        this.updateStatusBar('Export canceled');
        await this.sidebar.setStatus('Export canceled.');
        return;
      }
      await vscode.workspace.fs.writeFile(saveUri, packageBytes);
      this.output.appendLine(`Exported ${saveUri.fsPath} (${packageBytes.byteLength} bytes).`);
      this.updateStatusBar('Export OK');
      await this.sidebar.setStatus(`Exported ${path.basename(saveUri.fsPath)}.`);
      void vscode.window.showInformationMessage(`Exported ${path.basename(saveUri.fsPath)}.`);
    } catch (error) {
      this.publishErrorDiagnostic(project, error);
      await revealProblemsView();
      this.output.appendLine(`Export failed: ${error?.message || error}`);
      this.updateStatusBar('Export failed');
      await this.sidebar.setStatus('Export failed.');
      void vscode.window.showErrorMessage(`Export RFP failed: ${error?.message || error}`);
    }
  }

  async getShaderCompiler() {
    if (!this.shaderCompilerPromise) {
      this.shaderCompilerPromise = createNodeShaderCompiler();
    }
    return await this.shaderCompilerPromise;
  }

  async requireCurrentProject() {
    await this.projects.refresh();
    await this.projects.selectProjectForActiveEditor();
    const project = this.projects.getCurrentProject();
    await this.sidebar.update();
    if (project) return project;
    void vscode.window.showWarningMessage('No filter project selected.');
    return null;
  }

  publishDiagnostics(project, diagnostics) {
    this.diagnostics.clear();
    const byUri = new Map();
    for (const diagnostic of diagnostics ?? []) {
      if (!diagnostic.path) continue;
      const uri = vscode.Uri.joinPath(project.rootUri, diagnostic.path);
      const startLine = Math.max(0, Number(diagnostic.line ?? 1) - 1);
      const startChar = Math.max(0, Number(diagnostic.column ?? 1) - 1);
      const range = new vscode.Range(startLine, startChar, startLine, startChar + 1);
      const severity = diagnostic.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
      const item = new vscode.Diagnostic(range, diagnostic.message, severity);
      item.code = diagnostic.code;
      item.source = 'Forge';
      const list = byUri.get(uri.toString()) ?? [];
      list.push(item);
      byUri.set(uri.toString(), list);
    }
    for (const [uriText, items] of byUri) {
      this.diagnostics.set(vscode.Uri.parse(uriText), items);
    }
  }

  publishErrorDiagnostic(project, error) {
    this.diagnostics.clear();
    if (!error?.diagnostics) return;
    this.publishDiagnostics(project, error.diagnostics);
  }
}

class ForgeSidebarProvider {
  constructor(context, projects, output, diagnostics) {
    this.context = context;
    this.projects = projects;
    this.output = output;
    this.diagnostics = diagnostics;
    this.view = null;
    this.largePanel = null;
    this.preview = null;
    this.previewInput = {
      kind: 'none',
      source: 'none',
      label: 'No preview input selected',
      mediaType: '',
      byteLength: 0,
      uri: null
    };
    this.status = 'Idle';
    this.parameterValues = null;
    this.pickerState = { pointId: '', rectId: '' };
    this.previewAspect = { mode: 'input', custom: 1 };
    this.runtimeInfo = null;
    this.runtimeDiagnosticUris = [];
  }

  async resolveWebviewView(view) {
    this.view = view;
    this.configureWebviewOptions(view.webview);
    view.webview.html = this.getHtml(view.webview, 'sidebar');
    this.bindWebviewMessages(view.webview);
    if (this.previewInput.kind === 'none') {
      await this.useDefaultPreviewInput('image');
    } else {
      await this.update();
    }
  }

  bindWebviewMessages(webview) {
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        this.output.appendLine('Forge webview ready.');
        await this.update();
      } else if (message?.type === 'webviewDiagnostic') {
        const detail = message.detail ? ` ${message.detail}` : '';
        this.output.appendLine(`Webview ${message.stage || 'diagnostic'}:${detail}`);
      } else if (message?.type === 'webviewError') {
        const detail = [message.message, message.filename, message.lineno, message.colno]
          .filter((item) => item !== undefined && item !== null && item !== '')
          .join(' ');
        this.output.appendLine(`Webview error: ${detail || 'unknown error'}`);
        this.status = `Webview error: ${message.message || 'unknown error'}`;
        await this.postState();
      } else if (message?.type === 'runPreview') {
        await vscode.commands.executeCommand('forge.runPreview');
      } else if (message?.type === 'unloadPreview') {
        await extensionState?.runner?.unloadPreview();
      } else if (message?.type === 'exportRpf') {
        await vscode.commands.executeCommand('forge.exportRpf');
      } else if (message?.type === 'openSettings') {
        await vscode.commands.executeCommand('forge.openSettings');
      } else if (message?.type === 'importPreviewInput') {
        await this.importPreviewInput();
      } else if (message?.type === 'useDefaultPreviewInput') {
        await this.useDefaultPreviewInput(message.kind);
      } else if (message?.type === 'selectProject') {
        await this.projects.setCurrentProject(message.root);
        await this.update();
      } else if (message?.type === 'openLargePreview') {
        this.acceptParameterValues(message.values);
        this.acceptPreviewAspect(message.previewAspect);
        this.acceptPickerState(message.pickerState);
        await this.openLargePreview();
      } else if (message?.type === 'parameterValuesChanged') {
        this.acceptParameterValues(message.values);
        await this.postStateExcept(message.viewMode);
      } else if (message?.type === 'pickerStateChanged') {
        this.acceptPickerState(message);
        await this.postStateExcept(message.viewMode);
      } else if (message?.type === 'previewAspectChanged') {
        this.acceptPreviewAspect(message.previewAspect);
        this.runtimeInfo = null;
        await this.postStateExcept(message.viewMode);
      } else if (message?.type === 'runtimeInfoChanged') {
        this.acceptRuntimeInfo(message);
        if (message.viewMode === 'large' && this.largePanel) {
          await this.postRuntimeInfoToWebview(this.view?.webview);
        }
      } else if (message?.type === 'runtimeErrorChanged') {
        this.output.appendLine(`Runtime error from webview: ${message.message || 'unknown runtime error'}`);
        this.publishRuntimeDiagnostic(message);
        await revealProblemsView();
      } else if (message?.type === 'runtimeErrorCleared') {
        this.clearRuntimeDiagnostic(message.projectRoot);
      }
    });
  }

  acceptParameterValues(values) {
    if (values && typeof values === 'object') {
      this.parameterValues = values;
    }
  }

  acceptPickerState(value) {
    if (!value || typeof value !== 'object') return;
    this.pickerState = {
      pointId: String(value.pointId || ''),
      rectId: String(value.rectId || '')
    };
  }

  acceptPreviewAspect(value) {
    if (!value || typeof value !== 'object') return;
    const allowedModes = new Set(['input', '9:16', '3:4', '1:1', '4:3', '16:9', 'custom']);
    const custom = Number(value.custom);
    this.previewAspect = {
      mode: allowedModes.has(value.mode) ? value.mode : 'input',
      custom: Number.isFinite(custom) ? Math.min(3, Math.max(0.3, custom)) : 1
    };
  }

  acceptRuntimeInfo(value) {
    if (!value || typeof value !== 'object') return;
    this.runtimeInfo = {
      result: value.result ?? null,
      sample: value.sample ?? null,
      history: Array.isArray(value.history) ? value.history : [],
      status: typeof value.status === 'string' ? value.status : ''
    };
  }

  publishRuntimeDiagnostic(message) {
    const project = this.findProjectForRoot(message.projectRoot) ?? this.projects.getCurrentProject();
    if (!project) {
      this.output.appendLine('Runtime diagnostic skipped: no current filter project.');
      return;
    }
    this.clearRuntimeDiagnostic(project.rootUri.toString());
    const diagnosticsByUri = createRuntimeDiagnosticsByUri(project, message.message);
    for (const [uriText, items] of diagnosticsByUri) {
      const uri = vscode.Uri.parse(uriText);
      this.diagnostics.set(uri, items);
      this.runtimeDiagnosticUris.push(uri);
      this.output.appendLine(`Published ${items.length} runtime diagnostic(s) to ${uri.fsPath || uri.toString()}.`);
    }
  }

  clearRuntimeDiagnostic(projectRoot = '') {
    if (this.runtimeDiagnosticUris.length > 0) {
      for (const uri of this.runtimeDiagnosticUris) {
        this.diagnostics.delete(uri);
      }
      this.runtimeDiagnosticUris = [];
    }
    const fallbackUri = (this.findProjectForRoot(projectRoot) ?? this.projects.getCurrentProject())?.manifestUri ?? null;
    if (fallbackUri) this.diagnostics.delete(fallbackUri);
  }

  findProjectForRoot(root) {
    if (!root) return null;
    return this.projects.projects.find((project) => project.rootUri.toString() === root) ?? null;
  }

  async update() {
    await this.postState();
  }

  async setStatus(status) {
    this.status = status;
    await this.postState();
  }

  async setPreviewResult(preview) {
    this.preview = preview;
    this.parameterValues = null;
    this.pickerState = { pointId: '', rectId: '' };
    this.runtimeInfo = null;
    this.status = preview.ok ? 'Preview compile OK.' : 'Preview failed.';
    await this.postState();
  }

  async unloadPreview() {
    this.preview = null;
    this.parameterValues = null;
    this.pickerState = { pointId: '', rectId: '' };
    this.runtimeInfo = null;
    this.status = 'Preview unloaded.';
    await this.postState();
  }

  async importPreviewInput() {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Import Preview File',
      filters: {
        'Images and Videos': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'm4v'],
        Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
        Videos: ['mp4', 'webm', 'mov', 'm4v']
      }
    });
    const uri = selection?.[0];
    if (!uri) return;
    const mediaType = inferMediaType(uri.fsPath);
    const kind = previewInputKindFromMediaType(mediaType);
    if (kind === 'unknown') {
      void vscode.window.showWarningMessage('Preview input must be an image or video file.');
      return;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    await this.setPreviewInput({
      kind,
      source: 'import',
      label: path.basename(uri.fsPath),
      mediaType,
      byteLength: stat.size,
      uri
    });
  }

  async useDefaultPreviewInput(kind) {
    const preset = PRESET_PREVIEW_INPUTS[kind];
    if (!preset) return;
    const uri = vscode.Uri.joinPath(this.context.extensionUri, ...preset.path);
    const stat = await vscode.workspace.fs.stat(uri);
    await this.setPreviewInput({
      kind,
      source: 'preset',
      label: preset.label,
      mediaType: preset.mediaType,
      byteLength: stat.size,
      uri
    });
  }

  async setPreviewInput(previewInput) {
    this.previewInput = previewInput;
    this.runtimeInfo = null;
    this.status = `Preview input: ${previewInput.label}.`;
    this.configureWebviewOptions(this.view?.webview);
    this.configureWebviewOptions(this.largePanel?.webview);
    await this.postState();
  }

  configureWebviewOptions(webview) {
    if (!webview) return;
    const localResourceRoots = [
      this.context.extensionUri,
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
    ];
    if (this.previewInput.uri?.scheme === 'file') {
      localResourceRoots.push(vscode.Uri.file(path.dirname(this.previewInput.uri.fsPath)));
    }
    webview.options = {
      enableScripts: true,
      localResourceRoots
    };
  }

  async postState() {
    await Promise.all([
      this.postStateToWebview(this.view?.webview, 'sidebar'),
      this.postStateToWebview(this.largePanel?.webview, 'large')
    ]);
  }

  async postStateExcept(viewMode) {
    const targets = [];
    if (viewMode !== 'sidebar') {
      targets.push(this.postStateToWebview(this.view?.webview, 'sidebar'));
    }
    if (viewMode !== 'large') {
      targets.push(this.postStateToWebview(this.largePanel?.webview, 'large'));
    }
    await Promise.all(targets);
  }

  async postRuntimeInfoToWebview(webview) {
    if (!webview) return;
    await webview.postMessage({
      type: 'runtimeInfoState',
      runtimeInfo: this.runtimeInfo
    });
  }

  async postStateToWebview(webview, viewMode) {
    if (!webview) return;
    const projects = this.projects.projects.map((project) => ({
      root: project.rootUri.toString(),
      name: project.name || path.basename(project.rootUri.fsPath),
      fsPath: project.rootUri.fsPath
    }));
    const current = this.projects.getCurrentProject();
    await webview.postMessage({
      type: 'state',
      viewMode,
      largePreviewOpen: Boolean(this.largePanel),
      projects,
      currentRoot: current?.rootUri.toString() ?? '',
      status: this.status,
      preview: this.preview,
      parameterValues: this.parameterValues,
      pickerState: this.pickerState,
      previewAspect: this.previewAspect,
      runtimeInfo: this.runtimeInfo,
      previewInput: this.getPreviewInputState(webview)
    });
  }

  getPreviewInputState(webview) {
    if (!this.previewInput.uri) {
      return {
        kind: 'none',
        source: 'none',
        label: this.previewInput.label,
        mediaType: '',
        byteLength: 0,
        uri: ''
      };
    }
    return {
      kind: this.previewInput.kind,
      source: this.previewInput.source,
      label: this.previewInput.label,
      mediaType: this.previewInput.mediaType,
      byteLength: this.previewInput.byteLength,
      uri: webview.asWebviewUri(this.previewInput.uri).toString()
    };
  }

  async openLargePreview() {
    if (this.largePanel) {
      this.largePanel.reveal(vscode.ViewColumn.Active);
      await this.postState();
      return;
    }
    this.largePanel = vscode.window.createWebviewPanel(
      'forgeLargePreview',
      'Forge Preview',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.configureWebviewOptions(this.largePanel.webview);
    this.largePanel.webview.html = this.getHtml(this.largePanel.webview, 'large');
    this.bindWebviewMessages(this.largePanel.webview);
    this.largePanel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) {
        event.webviewPanel.dispose();
      }
    });
    this.largePanel.onDidDispose(() => {
      this.largePanel = null;
      void this.postState();
    });
    await this.postState();
  }

  getHtml(webview, viewMode = 'sidebar') {
    const nonce = createNonce();
    const webviewScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const bootScript = `
(() => {
  const boot = { bundleEntered: false, ready: false };
  globalThis.__forgeWebviewBoot = boot;
  const api = acquireVsCodeApi();
  globalThis.__forgeVsCodeApi = api;
  const status = document.getElementById('status');
  const setStatus = (message) => {
    if (status) status.textContent = message;
  };
  const report = (payload) => {
    try {
      api.postMessage(payload);
    } catch {
      // The status text still gives visible feedback if posting is unavailable.
    }
  };
  globalThis.__forgeWebviewReport = report;
  setStatus('Webview bootstrap active. Waiting for bundle...');
  report({ type: 'webviewDiagnostic', stage: 'bootstrap', detail: 'inline bootstrap active' });
  globalThis.addEventListener('error', (event) => {
    const message = event?.message || String(event?.error || 'unknown error');
    setStatus('Webview error: ' + message);
    report({
      type: 'webviewError',
      message,
      filename: event?.filename || '',
      lineno: event?.lineno || 0,
      colno: event?.colno || 0
    });
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    const message = reason?.message || String(reason || 'unknown rejection');
    setStatus('Webview rejection: ' + message);
    report({ type: 'webviewError', message });
  });
  globalThis.setTimeout(() => {
    if (boot.ready) return;
    const stage = boot.bundleEntered ? 'bundle entered but did not become ready' : 'bundle did not enter';
    setStatus('Webview startup timeout: ' + stage);
    report({ type: 'webviewDiagnostic', stage: 'startup-timeout', detail: stage });
  }, 2000);
})();`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; media-src ${webview.cspSource} data: blob:; style-src 'unsafe-inline' ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body { min-height: 100%; }
    body { margin: 0; padding: 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
    body[data-view-mode="large"] { padding: 0; overflow: hidden; }
    .stack { display: flex; flex-direction: column; gap: 8px; }
    body[data-view-mode="large"] .stack { height: 100vh; display: block; }
    select, button, input { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 4px 6px; min-height: 24px; font: inherit; }
    button { cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.icon-button { width: 24px; min-height: 24px; padding: 0; display: inline-grid; place-items: center; border: 1px solid var(--vscode-button-border, transparent); }
    button.tool-icon-button { display: inline-grid; place-items: center; padding: 4px; }
    button svg { width: 14px; height: 14px; display: block; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .button-row, .input-actions { display: grid; gap: 4px; }
    .button-row { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .input-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .secondary.active-input { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .input-actions .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .input-actions .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .input-actions .secondary.active-input { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
    .preview { position: relative; width: 100%; height: min(calc(100vw / var(--preview-aspect-ratio-value, 1.6)), var(--preview-max-height, 220px)); display: grid; place-items: center; overflow: hidden; border: 1px solid var(--vscode-panel-border); background-color: #8f8f8f; background-image: linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%); background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0; color: var(--vscode-descriptionForeground); text-align: center; }
    body[data-view-mode="large"] .preview { width: 100vw; height: 100vh; max-height: none; min-height: 0; aspect-ratio: auto; border: 0; }
    body[data-view-mode="large"] .preview canvas, body[data-view-mode="large"] .preview img, body[data-view-mode="large"] .preview video { max-width: 100vw; max-height: 100vh; }
    body[data-view-mode="large"] .large-preview-button { display: none; }
    body[data-view-mode="large"] section:not(#previewSection) { display: none; }
    body[data-view-mode="sidebar"].large-preview-open #previewSection { display: none; }
    body[data-view-mode="sidebar"].large-preview-open #largePreviewNotice { display: block; }
    #largePreviewNotice { display: none; }
    .preview::after { content: attr(data-message); position: absolute; inset: 0; display: grid; place-items: center; padding: 12px; white-space: pre-wrap; pointer-events: none; }
    .preview canvas, .preview img, .preview video { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; background: transparent; }
    .preview-media-host { display: grid; place-items: center; width: 100%; height: 100%; overflow: hidden; }
    .preview-media-host.preview-media-host-sampling { position: fixed; left: -10000px; top: 0; width: 160px; height: 90px; overflow: hidden; pointer-events: none; }
    .preview-media-host.preview-media-host-sampling img, .preview-media-host.preview-media-host-sampling video { width: 160px; height: 90px; max-width: none; max-height: none; }
    .preview-pick-layer { position: absolute; inset: 0; cursor: crosshair; }
    .preview-aspect-controls { position: absolute; left: 8px; top: 8px; z-index: 6; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 16px); opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
    .preview:hover .preview-aspect-controls, .preview:focus-within .preview-aspect-controls { opacity: 1; pointer-events: auto; }
    .preview-aspect-controls select { width: auto; min-width: 74px; max-width: 96px; min-height: 24px; padding: 2px 20px 2px 6px; background-color: var(--vscode-input-background); }
    .preview-aspect-controls input { width: 58px; min-height: 24px; padding: 2px 4px; text-align: right; }
    .preview-aspect-controls input.invalid { border-color: var(--vscode-errorForeground, #f48771); color: var(--vscode-errorForeground, #f48771); }
    .preview-aspect-error { color: var(--vscode-errorForeground, #f48771); font-size: 10px; font-weight: 700; white-space: nowrap; text-shadow: 0 1px 1px #000; }
    .large-preview-button { position: absolute; right: 8px; bottom: 8px; z-index: 5; width: 28px; min-height: 28px; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
    .preview:hover .large-preview-button, .large-preview-button:focus { opacity: 1; pointer-events: auto; }
    .preview-handle { position: absolute; width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px #000; pointer-events: none; }
    .preview-rect { position: absolute; box-sizing: border-box; border: 2px solid #fff; box-shadow: inset 0 0 0 1px #000; background: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent); pointer-events: none; }
    .hidden { display: none !important; }
    .status, .meta, .info { font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .debug-section { display: flex; flex-direction: column; gap: 6px; min-height: 96px; }
    .debug-tabs, .runtime-subtabs { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
    .debug-tab, .runtime-subtab { flex: 1; min-height: 22px; padding: 3px 6px; border: 1px solid transparent; color: var(--vscode-descriptionForeground); background: transparent; }
    .debug-tab:hover, .runtime-subtab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .debug-tab.active, .runtime-subtab.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-focusBorder); }
    .debug-tab-content, .runtime-subtab-panel { display: none; }
    .debug-tab-content.active, .runtime-subtab-panel.active { display: block; }
    .info-box { min-height: 32px; padding: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
    .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; margin-bottom: 6px; }
    .summary-pill { padding: 5px 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
    .summary-label { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
    .summary-value { display: block; color: var(--vscode-foreground); font-weight: 600; }
    .info-section { border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; margin-top: 6px; }
    .info-section-title { color: var(--vscode-foreground); font-weight: 600; margin-bottom: 4px; }
    .info-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; margin: 4px 0; }
    .info-name { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info-sub { color: var(--vscode-descriptionForeground); }
    .metric-bar { height: 4px; background: var(--vscode-input-background); overflow: hidden; margin-top: 2px; }
    .metric-bar span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
    .runtime-inspector { display: flex; flex-direction: column; gap: 6px; }
    .runtime-trend-chart { display: block; width: 100%; height: 92px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
    .runtime-chart-line { fill: none; stroke-width: 2; }
    .runtime-chart-grid { stroke: var(--vscode-panel-border); stroke-width: 1; }
    .runtime-chart-label { fill: var(--vscode-descriptionForeground); font-size: 10px; }
    .details-pre { margin: 6px 0 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); }
    .params { display: flex; flex-direction: column; gap: 6px; }
    .param { border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; }
    .param-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto; align-items: center; gap: 6px; margin-bottom: 4px; }
    .param label { display: block; font-size: 12px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .param-value { max-width: 160px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    .vec4-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .vec4-grid label { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px; align-items: center; }
    .param-ndc-point-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px; gap: 4px; align-items: center; }
    .param-ndc-rect-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) 28px; gap: 4px; align-items: center; }
    .param-ndc-point-row label, .param-ndc-rect-row label { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px; align-items: center; }
    .param-pick-button { width: 28px; min-height: 24px; padding: 3px; }
    .param-pick-button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .param-control-row { display: grid; grid-template-columns: minmax(0, 1fr) 72px; gap: 8px; align-items: center; }
    .param-control-row input[type="range"] { min-width: 0; padding-left: 0; padding-right: 0; }
    .param-control-row input[type="number"] { width: 72px; min-width: 0; text-align: right; }
    .alpha-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 48px; gap: 6px; align-items: center; margin-top: 6px; color: var(--vscode-descriptionForeground); }
    .param-color-inputs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
    .param-color-inputs input[type="number"] { width: 100%; min-width: 0; padding: 3px 4px; text-align: center; }
    .param-color-inputs input:disabled { opacity: 0.58; cursor: not-allowed; }
    .param-color-palette { display: block; width: 100%; height: 46px; margin-top: 5px; border: 1px solid var(--vscode-panel-border); cursor: crosshair; }
    .param-color-alpha { width: 100%; margin-top: 5px; }
    .param-bool-toggle { width: 16px; height: 16px; min-height: 16px; padding: 0; justify-self: end; }
    .toggle-row { display: flex; align-items: center; gap: 6px; }
    input[type="checkbox"], input[type="color"] { width: auto; }
    .empty { color: var(--vscode-descriptionForeground); }
    code { color: var(--vscode-textPreformat-foreground); }
  </style>
</head>
<body data-view-mode="${viewMode}">
  <div class="stack">
    <section>
      <h3>Current Filter</h3>
      <select id="projectSelect"></select>
    </section>
    <section class="button-row">
      <button id="runPreview">Run Preview</button>
      <button id="unloadPreview" class="secondary">Unload</button>
      <button id="exportRpf">Export RFP</button>
      <button id="settings" class="settings tool-icon-button" type="button" title="Settings" aria-label="Settings">${iconSvg('settings')}</button>
    </section>
    <section>
      <h3>Preview Input</h3>
      <div class="input-actions">
        <button id="importPreviewInput">Import Preview File</button>
        <button id="defaultImage" class="secondary">Default Image</button>
        <button id="defaultVideo" class="secondary">Default Video</button>
      </div>
      <p id="previewInputStatus" class="meta">No preview input selected</p>
    </section>
    <section id="previewHeader">
      <h3>Preview</h3>
      <p id="largePreviewNotice" class="meta">Large preview is open.</p>
    </section>
    <section id="previewSection">
      <div id="preview" class="preview" data-message="Run Preview">
        <div id="previewAspectControls" class="preview-aspect-controls hidden">
          <select id="previewAspectSelect" title="Output aspect ratio" aria-label="Output aspect ratio">
            <option value="input">按输入</option>
            <option value="9:16">9:16</option>
            <option value="3:4">3:4</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="16:9">16:9</option>
            <option value="custom">自定义</option>
          </select>
          <input id="customAspectInput" class="hidden" type="number" min="0.3" max="3" step="0.01" title="Custom aspect ratio" aria-label="Custom aspect ratio">
          <span id="customAspectError" class="preview-aspect-error hidden">0.3-3</span>
        </div>
        <button id="largePreview" class="secondary large-preview-button tool-icon-button" type="button" title="Open large preview" aria-label="Open large preview">${iconSvg('maximize')}</button>
        <canvas id="previewCanvas" class="hidden"></canvas>
        <div id="rawPreviewHost" class="preview-media-host hidden">
          <img id="rawPreviewImage" class="hidden" alt="Preview input image">
          <video id="rawPreviewVideo" class="hidden" controls muted loop autoplay playsinline></video>
        </div>
        <div id="previewPickLayer" class="preview-pick-layer hidden"></div>
        <div id="previewHandle" class="preview-handle hidden"></div>
        <div id="previewRect" class="preview-rect hidden"></div>
      </div>
    </section>
    <section>
      <h3>Parameters</h3>
      <div id="params" class="params empty">No preview data.</div>
    </section>
    <section class="debug-section">
      <div class="debug-tabs" role="tablist" aria-label="Preview debug information">
        <button class="debug-tab active" type="button" data-debug-tab="static">Static</button>
        <button class="debug-tab" type="button" data-debug-tab="runtime">Runtime</button>
      </div>
      <div id="staticInfo" class="info info-box debug-tab-content active" role="tabpanel">No compile data.</div>
      <div id="runtimeInfo" class="info info-box debug-tab-content" role="tabpanel">No runtime data.</div>
    </section>
    <section>
      <h3>Status</h3>
      <div id="status" class="status">Idle</div>
    </section>
  </div>
  <script nonce="${nonce}">${bootScript}</script>
  <script nonce="${nonce}" type="module" src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}

class ForgeSettingsPanel {
  constructor(context) {
    this.context = context;
    this.panel = null;
  }

  show() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.postState();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'forgeSettings',
      'Forge Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    void this.postState();
  }

  async handleMessage(message) {
    if (message?.type === 'generateMasterKey') {
      await this.panel?.webview.postMessage({
        type: 'generatedMasterKey',
        masterKey: crypto.randomBytes(32).toString('base64url')
      });
    } else if (message?.type === 'generateKeyPair') {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      await this.panel?.webview.postMessage({
        type: 'generatedKeyPair',
        privateKey,
        publicKey,
        fingerprint: createFingerprint(publicKey)
      });
    } else if (message?.type === 'saveKeys') {
      const savedMasterKey = await this.context.secrets.get(SECRET_MASTER_KEY) ?? '';
      const savedPrivateKey = await this.context.secrets.get(SECRET_PRIVATE_KEY) ?? '';
      const masterKey = String(message.masterKey ?? '');
      const privateKeyText = String(message.privateKey ?? '');
      const privateKey = privateKeyText.trim() ? privateKeyText : '';
      const masterDirty = masterKey !== savedMasterKey;
      const privateDirty = privateKey !== savedPrivateKey;

      if (masterDirty && masterKey) {
        await this.context.secrets.store(SECRET_MASTER_KEY, masterKey);
      } else if (masterDirty) {
        await this.context.secrets.delete(SECRET_MASTER_KEY);
      }

      if (privateDirty) {
        let publicKey = '';
        try {
          publicKey = privateKey ? derivePublicKeyFromPrivateKey(privateKey) : '';
        } catch (error) {
          void vscode.window.showErrorMessage(`Invalid private key: ${error?.message || error}`);
          await this.postState();
          await this.panel?.webview.postMessage({
            type: 'saveError',
            field: 'privateKey',
            message: error?.message || String(error)
          });
          return;
        }
        if (privateKey) {
          await this.context.secrets.store(SECRET_PRIVATE_KEY, privateKey);
        } else {
          await this.context.secrets.delete(SECRET_PRIVATE_KEY);
        }
        await this.context.globalState.update(PUBLIC_KEY_KEY, publicKey || undefined);
      }

      await this.postState();
      void vscode.window.showInformationMessage('Keys saved.');
    } else if (message?.type === 'clearKeys') {
      await this.context.secrets.delete(SECRET_MASTER_KEY);
      await this.context.secrets.delete(SECRET_PRIVATE_KEY);
      await this.context.globalState.update(PUBLIC_KEY_KEY, undefined);
      await this.postState();
    } else if (message?.type === 'copyText') {
      const text = String(message.text || '');
      if (text) {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(`${message.label || 'Value'} copied.`);
      }
    }
  }

  async postState() {
    if (!this.panel) return;
    const masterKey = await this.context.secrets.get(SECRET_MASTER_KEY);
    const privateKey = await this.context.secrets.get(SECRET_PRIVATE_KEY);
    const publicKey = this.context.globalState.get(PUBLIC_KEY_KEY, '');
    await this.panel.webview.postMessage({
      type: 'state',
      hasMasterKey: Boolean(masterKey),
      hasPrivateKey: Boolean(privateKey),
      masterKey: masterKey || '',
      privateKey: privateKey || '',
      publicKey,
      fingerprint: publicKey ? createFingerprint(publicKey) : ''
    });
  }

  getHtml(webview) {
    const nonce = createNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .stack { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    button, input, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; margin-right: 8px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    input { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); }
    textarea { width: 100%; min-height: 180px; box-sizing: border-box; font-family: var(--vscode-editor-font-family); }
    .actions, .settings-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .actions button { margin-right: 0; }
    .settings-actions { margin-bottom: 4px; }
    .section-heading { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; }
    .dirty-badge { color: var(--vscode-errorForeground, #f48771); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .field-error { color: var(--vscode-errorForeground, #f48771); font-weight: 700; margin: 6px 0 0; white-space: pre-wrap; }
    .muted { color: var(--vscode-descriptionForeground); margin: 0 0 6px; }
    .hidden { display: none !important; }
    pre { white-space: pre-wrap; padding: 12px; background: var(--vscode-textCodeBlock-background); }
  </style>
</head>
<body>
  <div class="stack">
    <h1>Forge Settings</h1>
    <div class="settings-actions">
      <button id="saveKeys">Save Keys</button>
      <button id="clearKeys">Clear Keys</button>
    </div>
    <section>
      <h2 class="section-heading">Master Key <span id="masterUnsaved" class="dirty-badge hidden">Unsaved</span></h2>
      <label for="masterKeyInput">Master Key</label>
      <input id="masterKeyInput" type="text" spellcheck="false" placeholder="Same string used with CLI --master-key">
      <p class="actions">
        <button id="generateMasterKey">Generate Master Key</button>
        <button id="copyMasterKey" class="secondary">Copy Master Key</button>
      </p>
    </section>
    <section>
      <h2 class="section-heading">Signing Private Key <span id="privateUnsaved" class="dirty-badge hidden">Unsaved</span></h2>
      <textarea id="privateKeyInput" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>
      <p id="privateKeyError" class="field-error hidden"></p>
      <p class="actions">
        <button id="generateKeyPair">Generate Key Pair</button>
        <button id="copyPrivateKey" class="secondary">Copy Private Key</button>
      </p>
    </section>
    <section>
      <h2>Public Key</h2>
      <p id="publicKeyMeta" class="muted"></p>
      <pre id="publicKey"></pre>
      <p class="actions">
        <button id="copyPublicKey" class="secondary">Copy Public Key</button>
        <button id="copyKeyBundle" class="secondary">Copy Key Bundle JSON</button>
      </p>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const masterKeyInput = document.getElementById('masterKeyInput');
    const privateKeyInput = document.getElementById('privateKeyInput');
    const masterUnsaved = document.getElementById('masterUnsaved');
    const privateUnsaved = document.getElementById('privateUnsaved');
    const privateKeyError = document.getElementById('privateKeyError');
    const publicKey = document.getElementById('publicKey');
    const publicKeyMeta = document.getElementById('publicKeyMeta');
    let currentPublicKey = '';
    let savedPublicKey = '';
    let savedFingerprint = '';
    let savedMasterKey = '';
    let savedPrivateKey = '';
    let hasReceivedState = false;
    let clearRequested = false;
    const restored = vscode.getState() || {};
    const hasRestoredMasterKey = typeof restored.masterKey === 'string';
    const hasRestoredPrivateKey = typeof restored.privateKey === 'string';
    if (typeof restored.masterKey === 'string') masterKeyInput.value = restored.masterKey;
    if (typeof restored.privateKey === 'string') privateKeyInput.value = restored.privateKey;
    if (typeof restored.publicKey === 'string') currentPublicKey = restored.publicKey;
    document.getElementById('generateMasterKey').addEventListener('click', () => vscode.postMessage({ type: 'generateMasterKey' }));
    document.getElementById('generateKeyPair').addEventListener('click', () => vscode.postMessage({ type: 'generateKeyPair' }));
    masterKeyInput.addEventListener('input', () => {
      updateDirtyState();
    });
    privateKeyInput.addEventListener('input', () => {
      privateKeyError.classList.add('hidden');
      currentPublicKey = privateKeyInput.value === savedPrivateKey ? savedPublicKey : '';
      renderPublicKey();
      updateDirtyState();
    });
    document.getElementById('copyMasterKey').addEventListener('click', () => copyText('Master key', masterKeyInput.value));
    document.getElementById('copyPrivateKey').addEventListener('click', () => copyText('Private key', privateKeyInput.value));
    document.getElementById('copyPublicKey').addEventListener('click', () => copyText('Public key', currentPublicKey));
    document.getElementById('copyKeyBundle').addEventListener('click', () => copyText('Key bundle JSON', JSON.stringify({
      masterKey: masterKeyInput.value,
      privateKey: privateKeyInput.value,
      publicKey: currentPublicKey
    }, null, 2)));
    document.getElementById('clearKeys').addEventListener('click', () => {
      clearRequested = true;
      vscode.postMessage({ type: 'clearKeys' });
    });
    document.getElementById('saveKeys').addEventListener('click', () => vscode.postMessage({
      type: 'saveKeys',
      masterKey: masterKeyInput.value,
      privateKey: privateKeyInput.value
    }));
    window.addEventListener('message', (event) => {
      const state = event.data;
      if (state?.type === 'generatedMasterKey') {
        masterKeyInput.value = state.masterKey || '';
        updateDirtyState();
        return;
      }
      if (state?.type === 'generatedKeyPair') {
        privateKeyInput.value = state.privateKey || '';
        privateKeyError.classList.add('hidden');
        currentPublicKey = '';
        renderPublicKey();
        updateDirtyState();
        return;
      }
      if (state?.type === 'saveError') {
        privateKeyError.textContent = 'Invalid private key: ' + (state.message || 'Invalid key');
        privateKeyError.classList.remove('hidden');
        updateDirtyState();
        return;
      }
      if (!state || state.type !== 'state') return;
      const nextSavedMasterKey = state.masterKey || '';
      const nextSavedPrivateKey = state.privateKey || '';
      const masterWasDirty = masterKeyInput.value !== savedMasterKey;
      const privateWasDirty = privateKeyInput.value !== savedPrivateKey;

      if ((!hasReceivedState && !hasRestoredMasterKey) || clearRequested || !masterWasDirty || masterKeyInput.value === nextSavedMasterKey) {
        masterKeyInput.value = nextSavedMasterKey;
      }
      if (
        (!hasReceivedState && !hasRestoredPrivateKey)
        || clearRequested
        || !privateWasDirty
        || privateKeyInput.value === nextSavedPrivateKey
        || (nextSavedPrivateKey === '' && privateKeyInput.value.trim() === '')
      ) {
        privateKeyInput.value = nextSavedPrivateKey;
      }

      savedMasterKey = nextSavedMasterKey;
      savedPrivateKey = nextSavedPrivateKey;
      savedPublicKey = state.publicKey || '';
      savedFingerprint = state.fingerprint || '';
      currentPublicKey = privateKeyInput.value === savedPrivateKey ? savedPublicKey : '';
      hasReceivedState = true;
      clearRequested = false;
      if (privateKeyInput.value === savedPrivateKey) privateKeyError.classList.add('hidden');
      renderPublicKey();
      updateDirtyState();
    });
    function copyText(label, text) {
      vscode.postMessage({ type: 'copyText', label, text });
    }
    function updateDirtyState() {
      masterUnsaved.classList.toggle('hidden', masterKeyInput.value === savedMasterKey);
      privateUnsaved.classList.toggle('hidden', privateKeyInput.value === savedPrivateKey);
      if (privateKeyInput.value === savedPrivateKey) currentPublicKey = savedPublicKey;
      persistDraft();
    }
    function renderPublicKey() {
      if (privateKeyInput.value !== savedPrivateKey) {
        publicKey.textContent = '';
        publicKeyMeta.textContent = '';
        return;
      }
      publicKey.textContent = currentPublicKey || 'No saved public key available.';
      publicKeyMeta.textContent = savedFingerprint ? 'Fingerprint: ' + savedFingerprint : '';
    }
    function persistDraft() {
      vscode.setState({
        masterKey: masterKeyInput.value,
        privateKey: privateKeyInput.value,
        publicKey: currentPublicKey
      });
    }
  </script>
</body>
</html>`;
  }
}

async function discoverFilterProjects(output = null) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const projects = [];
  output?.appendLine(`Scanning ${folders.length} workspace folder(s) for filter projects.`);
  for (const folder of folders) {
    const manifests = [];
    await collectManifestFiles(folder.uri, manifests);
    output?.appendLine(`Workspace ${folder.uri.fsPath}: found ${manifests.length} manifest.json file(s).`);
    for (const manifestUri of manifests) {
      const rootUri = vscode.Uri.file(path.dirname(manifestUri.fsPath));
      const mainLuaUri = vscode.Uri.joinPath(rootUri, 'main.lua');
      if (!await exists(mainLuaUri)) {
        output?.appendLine(`Skip ${manifestUri.fsPath}: missing main.lua.`);
        continue;
      }
      const manifest = parseJsonFile(await readTextFile(manifestUri));
      if (!isFilterManifest(manifest)) {
        output?.appendLine(`Skip ${manifestUri.fsPath}: manifest does not look like filter-src.`);
        continue;
      }
      projects.push({
        rootUri,
        manifestUri,
        mainLuaUri,
        id: manifest?.metadata?.id,
        name: manifest?.metadata?.name || manifest?.metadata?.id || path.basename(rootUri.fsPath)
      });
    }
  }
  return projects.sort((left, right) => left.rootUri.fsPath.localeCompare(right.rootUri.fsPath));
}

async function collectManifestFiles(directoryUri, manifests) {
  let entries;
  try {
    entries = await vscode.workspace.fs.readDirectory(directoryUri);
  } catch {
    return;
  }

  for (const [name, type] of entries) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const childUri = vscode.Uri.joinPath(directoryUri, name);
    if (type === vscode.FileType.Directory) {
      await collectManifestFiles(childUri, manifests);
    } else if (type === vscode.FileType.File && name === 'manifest.json') {
      manifests.push(childUri);
    }
  }
}

function isFilterManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const schema = String(manifest.$schema ?? '');
  if (schema.includes('filter-src')) return true;
  if (manifest.metadata?.kind === 'filter-src') return true;
  return Number.isInteger(manifest.runtimeVersion)
    && Array.isArray(manifest.passes)
    && Array.isArray(manifest.parameters ?? []);
}

function findProjectContainingUri(projects, uri) {
  const filePath = uri.fsPath.toLowerCase();
  return projects
    .filter((project) => filePath === project.rootUri.fsPath.toLowerCase()
      || filePath.startsWith(`${project.rootUri.fsPath.toLowerCase()}${path.sep}`))
    .sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length)[0] ?? null;
}

async function saveDirtyProjectDocuments(rootUri) {
  const dirtyDocuments = vscode.workspace.textDocuments.filter((document) =>
    document.isDirty && isUriInsideDirectory(document.uri, rootUri)
  );
  const savedDocuments = [];
  for (const document of dirtyDocuments) {
    const saved = await document.save();
    if (!saved) {
      throw new Error(`Failed to save ${document.uri.fsPath || document.uri.toString()}.`);
    }
    savedDocuments.push(document.uri);
  }
  return savedDocuments;
}

function isUriInsideDirectory(uri, directoryUri) {
  if (uri.scheme !== 'file' || directoryUri.scheme !== 'file') return false;
  const relativePath = path.relative(directoryUri.fsPath, uri.fsPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function readFilterProjectFiles(rootUri) {
  const files = {};
  await walkFiles(rootUri, async (fileUri, relativePath) => {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    files[relativePath] = isTextFile(relativePath) ? new TextDecoder().decode(bytes) : bytes;
  });
  return files;
}

async function walkFiles(directoryUri, visit, baseUri = directoryUri) {
  const entries = await vscode.workspace.fs.readDirectory(directoryUri);
  for (const [name, type] of entries) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const childUri = vscode.Uri.joinPath(directoryUri, name);
    if (type === vscode.FileType.Directory) {
      await walkFiles(childUri, visit, baseUri);
    } else if (type === vscode.FileType.File) {
      const relativePath = path.relative(baseUri.fsPath, childUri.fsPath).replace(/\\/g, '/');
      await visit(childUri, relativePath);
    }
  }
}

function isTextFile(filePath) {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(uri) {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function parseJsonFile(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function serializeFileMap(files) {
  const output = {};
  for (const [name, value] of Object.entries(files ?? {})) {
    if (typeof value === 'string') {
      output[name] = value;
    } else if (value instanceof Uint8Array) {
      output[name] = {
        encoding: 'base64',
        data: Buffer.from(value).toString('base64')
      };
    } else if (ArrayBuffer.isView(value)) {
      output[name] = {
        encoding: 'base64',
        data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
      };
    }
  }
  return output;
}

async function chooseRpfSaveUri(project) {
  const config = vscode.workspace.getConfiguration('forge');
  const outputDirectory = config.get('defaultOutputDirectory', 'dist');
  const defaultUri = vscode.Uri.joinPath(
    project.rootUri,
    outputDirectory,
    `${sanitizeFilename(project.name || path.basename(project.rootUri.fsPath))}.rfp`
  );
  return await vscode.window.showSaveDialog({
    defaultUri,
    filters: {
      'Filter Package': ['rfp']
    }
  });
}

function sanitizeFilename(value) {
  return String(value || 'filter').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-');
}

function createNonce() {
  return crypto.randomBytes(16).toString('base64');
}

async function revealProblemsView() {
  try {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  } catch {
    // The command is built into VS Code, but failing to reveal Problems should not hide the compile error.
  }
}

function createRuntimeDiagnosticsByUri(project, message) {
  const text = message || 'Unknown runtime error';
  const byUri = new Map();
  const luaDiagnostic = parseRuntimeLuaDiagnostic(text);
  if (luaDiagnostic) {
    const uri = vscode.Uri.joinPath(project.rootUri, 'main.lua');
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(luaDiagnostic.line, 0, luaDiagnostic.line, 1),
      luaDiagnostic.message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'Forge';
    diagnostic.code = 'runtime_error';
    byUri.set(uri.toString(), [diagnostic]);
    return byUri;
  }

  for (const item of parseRuntimeShaderDiagnostics(text)) {
    const uri = vscode.Uri.joinPath(project.rootUri, item.path);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(item.line, item.column, item.line, item.column + 1),
      item.message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'Forge';
    diagnostic.code = 'runtime_error';
    const key = uri.toString();
    const list = byUri.get(key) ?? [];
    list.push(diagnostic);
    byUri.set(key, list);
  }

  if (byUri.size > 0) return byUri;

  const uri = project.manifestUri ?? vscode.Uri.joinPath(project.rootUri, 'manifest.json');
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 1),
    `Preview runtime failed: ${text}`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Forge';
  diagnostic.code = 'runtime_error';
  byUri.set(uri.toString(), [diagnostic]);
  return byUri;
}

function parseRuntimeLuaDiagnostic(message) {
  const match = /\[string\s+"[\s\S]*?"\]:(\d+):\s*(.+)$/m.exec(String(message || ''));
  if (!match) return null;
  return {
    line: Math.max(0, Number(match[1]) - 1),
    message: `Preview runtime failed: ${match[2].trim()}`
  };
}

function parseRuntimeShaderDiagnostics(message) {
  const diagnostics = [];
  const pattern = /([^\s()[\]]+\.glsl):(\d+):(\d+)/g;
  for (const line of String(message || '').split(/\r?\n/)) {
    for (const match of line.matchAll(pattern)) {
      const pathText = match[1].replace(/\\/g, '/');
      const lineNumber = Math.max(0, Number(match[2]) - 1);
      const columnNumber = Math.max(0, Number(match[3]) - 1);
      const detail = line.slice((match.index ?? 0) + match[0].length)
        .replace(/^\s*(?:\([^)]*\))?:?\s*/, '')
        .trim();
      diagnostics.push({
        path: pathText,
        line: lineNumber,
        column: columnNumber,
        message: detail ? `Preview runtime failed: ${detail}` : `Preview runtime failed at ${pathText}:${lineNumber + 1}:${columnNumber + 1}`
      });
    }
  }
  return diagnostics;
}

function iconSvg(name) {
  const icons = {
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8a2 2 0 0 1 0-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2a2 2 0 0 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>',
    maximize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M21 16v5h-5"/><path d="M8 21H3v-5"/><path d="M3 3l6 6"/><path d="M21 3l-6 6"/><path d="M21 21l-6-6"/><path d="M3 21l6-6"/></svg>'
  };
  return icons[name] ?? '';
}

function createFingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function derivePublicKeyFromPrivateKey(privateKey) {
  return crypto.createPublicKey(privateKey).export({
    type: 'spki',
    format: 'pem'
  });
}

function inferMediaType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function previewInputKindFromMediaType(mediaType) {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('video/')) return 'video';
  return 'unknown';
}
