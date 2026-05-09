import { renderFilterPreview } from './filter-runtime.js';

const vscode = globalThis.__forgeVsCodeApi ?? acquireVsCodeApi();

const projectSelect = document.getElementById('projectSelect');
const statusEl = document.getElementById('status');
const previewInputStatusEl = document.getElementById('previewInputStatus');
const previewStage = document.getElementById('preview');
const previewAspectControls = document.getElementById('previewAspectControls');
const previewAspectSelect = document.getElementById('previewAspectSelect');
const customAspectInput = document.getElementById('customAspectInput');
const customAspectError = document.getElementById('customAspectError');
const canvas = document.getElementById('previewCanvas');
const rawPreviewHost = document.getElementById('rawPreviewHost');
const rawImage = document.getElementById('rawPreviewImage');
const rawVideo = document.getElementById('rawPreviewVideo');
const videoProbeCanvas = document.createElement('canvas');
const videoProbeContext = videoProbeCanvas.getContext('2d', { willReadFrequently: true });
const pickLayer = document.getElementById('previewPickLayer');
const previewHandle = document.getElementById('previewHandle');
const previewRect = document.getElementById('previewRect');
const paramsEl = document.getElementById('params');
const staticInfoEl = document.getElementById('staticInfo');
const runtimeInfoEl = document.getElementById('runtimeInfo');
const debugTabs = Array.from(document.querySelectorAll('[data-debug-tab]'));
const debugPanels = {
  static: staticInfoEl,
  runtime: runtimeInfoEl
};

let currentState = null;
let compiledFiles = null;
let sourceFiles = null;
let parameterValues = {};
let previewInputFile = null;
let previewInputKey = '';
let previewInputObjectUrl = '';
let selectedNdcPointId = '';
let selectedNdcRectId = '';
let ndcRectDragStart = null;
let renderTimer = 0;
let renderQueued = false;
let renderInFlight = false;
let runtimeHistory = [];
let runtimeSampleIndex = 0;
let activeRuntimeTab = 'trend';
let runtimeRoot = '';
let previewOutputSize = null;
let lastRuntimeOutputSize = null;
let previewAspectState = { mode: 'input', custom: 1 };
let customAspectDraft = '1';
let videoRenderFrameId = 0;
let continuousRenderFrameId = 0;
let lastContinuousRenderMs = 0;
let renderTimeline = createRenderTimelineState();
let previewIdentity = '';
let lastRuntimeInfoUpdateMs = 0;
let runtimeErrorKey = '';
let applyingRemoteState = false;

const MAX_RUNTIME_HISTORY = 80;
const VIDEO_RUNTIME_INFO_UPDATE_INTERVAL_MS = 250;
const CONTINUOUS_RENDER_INTERVAL_MS = 33;
const CUSTOM_ASPECT_MIN = 0.3;
const CUSTOM_ASPECT_MAX = 3;
const PREVIEW_ASPECT_RATIOS = {
  '9:16': 9 / 16,
  '3:4': 3 / 4,
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9
};
const PREVIEW_ASPECT_MODES = new Set(['input', ...Object.keys(PREVIEW_ASPECT_RATIOS), 'custom']);

document.getElementById('runPreview').addEventListener('click', () => vscode.postMessage({ type: 'runPreview' }));
document.getElementById('unloadPreview').addEventListener('click', () => vscode.postMessage({ type: 'unloadPreview' }));
document.getElementById('exportRpf').addEventListener('click', () => vscode.postMessage({ type: 'exportRpf' }));
document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
document.getElementById('largePreview').addEventListener('click', () => vscode.postMessage({
  type: 'openLargePreview',
  values: parameterValues,
  previewAspect: previewAspectState,
  pickerState: {
    pointId: selectedNdcPointId,
    rectId: selectedNdcRectId
  }
}));
document.getElementById('importPreviewInput').addEventListener('click', () => vscode.postMessage({ type: 'importPreviewInput' }));
document.getElementById('defaultImage').addEventListener('click', () => vscode.postMessage({ type: 'useDefaultPreviewInput', kind: 'image' }));
document.getElementById('defaultVideo').addEventListener('click', () => vscode.postMessage({ type: 'useDefaultPreviewInput', kind: 'video' }));
projectSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectProject', root: projectSelect.value }));
previewAspectSelect.addEventListener('change', handlePreviewAspectModeChange);
customAspectInput.addEventListener('input', handleCustomAspectInput);
customAspectInput.addEventListener('blur', () => {
  if (!isCustomAspectDraftValid(customAspectDraft)) return;
  customAspectDraft = formatAspectNumber(previewAspectState.custom);
  renderPreviewAspectControls();
});
for (const button of debugTabs) {
  button.addEventListener('click', () => selectDebugTab(button.dataset.debugTab));
}
runtimeInfoEl.addEventListener('pointerdown', handleRuntimeTabEvent);
runtimeInfoEl.addEventListener('click', handleRuntimeTabEvent);

function handleRuntimeTabEvent(event) {
  const button = event.target.closest('[data-runtime-tab]');
  if (!button) return;
  event.preventDefault();
  activeRuntimeTab = button.dataset.runtimeTab || 'trend';
  for (const item of runtimeInfoEl.querySelectorAll('[data-runtime-tab]')) {
    item.classList.toggle('active', item === button);
  }
  for (const panel of runtimeInfoEl.querySelectorAll('[data-runtime-panel]')) {
    panel.classList.toggle('active', panel.dataset.runtimePanel === activeRuntimeTab);
  }
}
pickLayer.addEventListener('pointerdown', (event) => {
  if (selectedNdcRectId && parameterValues[selectedNdcRectId]) {
    event.preventDefault();
    pickLayer.setPointerCapture(event.pointerId);
    ndcRectDragStart = pointerToNdc(event);
    applyNdcRectFromPointer(event);
    return;
  }
  if (!selectedNdcPointId || !parameterValues[selectedNdcPointId]) return;
  event.preventDefault();
  applyNdcPointFromPointer(event);
});
pickLayer.addEventListener('pointermove', (event) => {
  if (selectedNdcRectId && ndcRectDragStart && event.buttons === 1) {
    event.preventDefault();
    applyNdcRectFromPointer(event);
    return;
  }
  if (!selectedNdcPointId || event.buttons !== 1) return;
  event.preventDefault();
  applyNdcPointFromPointer(event);
});
pickLayer.addEventListener('pointerup', () => {
  ndcRectDragStart = null;
});
pickLayer.addEventListener('pointercancel', () => {
  ndcRectDragStart = null;
});
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'runtimeInfoState') {
    applyRemoteRuntimeInfo(message.runtimeInfo);
    return;
  }
  void renderState(message);
});
if (globalThis.__forgeWebviewBoot) {
  globalThis.__forgeWebviewBoot.ready = true;
}
vscode.postMessage({ type: 'ready' });
window.addEventListener('resize', () => refitVisiblePreview());
rawImage.addEventListener('load', () => {
  if (!compiledFiles && !rawImage.classList.contains('hidden')) {
    fitPreviewMedia(rawImage, rawImage.naturalWidth, rawImage.naturalHeight);
  }
});
rawVideo.addEventListener('loadedmetadata', () => {
  if (!compiledFiles && !rawVideo.classList.contains('hidden')) {
    fitPreviewMedia(rawVideo, rawVideo.videoWidth, rawVideo.videoHeight);
  }
});

function createRenderTimelineState() {
  return {
    startMs: performance.now(),
    lastMs: null,
    frameIndex: 0
  };
}

function resetRenderTimeline() {
  renderTimeline = createRenderTimelineState();
}

function nextRenderTimelineSample() {
  const now = performance.now();
  const deltaSeconds = renderTimeline.lastMs === null
    ? 0
    : Math.max(0, (now - renderTimeline.lastMs) / 1000);
  const sample = {
    frameIndex: renderTimeline.frameIndex,
    timeSeconds: Math.max(0, (now - renderTimeline.startMs) / 1000),
    deltaSeconds
  };
  renderTimeline.lastMs = now;
  renderTimeline.frameIndex += 1;
  return sample;
}

async function renderState(state) {
  if (!state || state.type !== 'state') return;
  if ((state.currentRoot || '') !== runtimeRoot) {
    runtimeRoot = state.currentRoot || '';
      runtimeHistory = [];
      runtimeSampleIndex = 0;
      lastRuntimeInfoUpdateMs = 0;
  }
  currentState = state;
  document.body.dataset.viewMode = state.viewMode || 'sidebar';
  document.body.classList.toggle('large-preview-open', Boolean(state.largePreviewOpen));
  applyRemotePreviewAspect(state.previewAspect);
  lastRuntimeOutputSize = getRuntimeInfoOutputSize(state.runtimeInfo);
  renderPreviewAspectControls();
  selectedNdcPointId = state.pickerState?.pointId || '';
  selectedNdcRectId = state.pickerState?.rectId || '';
  projectSelect.innerHTML = '';
  if (!state.projects.length) {
    projectSelect.append(new Option('No filter project found', ''));
  } else {
    for (const project of state.projects) {
      projectSelect.append(new Option(project.name, project.root));
    }
  }
  const selectedRoot = state.projects.some((project) => project.root === state.currentRoot)
    ? state.currentRoot
    : state.projects[0]?.root ?? '';
  projectSelect.value = selectedRoot;
  statusEl.textContent = state.status || 'Idle';

  if (state.preview?.ok) {
    const nextPreviewIdentity = `${state.preview.projectRoot || ''}:${JSON.stringify(state.preview.manifest ?? {})}`;
    if (nextPreviewIdentity !== previewIdentity) {
      previewIdentity = nextPreviewIdentity;
      resetRenderTimeline();
    }
    compiledFiles = decodeFileMap(state.preview.compiledFiles);
    sourceFiles = decodeFileMap(state.preview.sourceFiles);
    Object.defineProperty(compiledFiles, '__sourceFiles', {
      value: sourceFiles,
      enumerable: false,
      configurable: true
    });
    syncParameterValues(state.preview.manifest?.parameters ?? []);
    applyRemoteParameterValues(state.parameterValues);
    renderParameters(state.preview.manifest?.parameters ?? []);
    staticInfoEl.innerHTML = formatStaticInfo(state.preview.manifest, state.preview.outputFiles);
    applyRemoteRuntimeInfo(state.runtimeInfo);
  } else {
    compiledFiles = null;
    sourceFiles = null;
    parameterValues = {};
    selectedNdcPointId = '';
    selectedNdcRectId = '';
    ndcRectDragStart = null;
    runtimeHistory = [];
    runtimeSampleIndex = 0;
    lastRuntimeInfoUpdateMs = 0;
    previewIdentity = '';
    resetRenderTimeline();
    stopVideoRenderLoop();
    stopContinuousRenderLoop();
    renderParameters([]);
    staticInfoEl.textContent = state.preview?.error || 'No compile data.';
    runtimeInfoEl.textContent = 'No runtime data.';
  }

  renderPreviewInputStatus(state.previewInput);
  await syncPreviewInputFile(state.previewInput);
  queueRender();
}

function renderPreviewInputStatus(previewInput) {
  document.getElementById('defaultImage').classList.toggle('active-input', previewInput?.source === 'preset' && previewInput?.kind === 'image');
  document.getElementById('defaultVideo').classList.toggle('active-input', previewInput?.source === 'preset' && previewInput?.kind === 'video');
  if (!previewInput || previewInput.kind === 'none') {
    previewInputStatusEl.textContent = 'No preview input selected';
    return;
  }
  const size = previewInput.byteLength ? formatBytes(previewInput.byteLength) : '';
  const source = previewInput.source === 'preset' ? 'preset' : 'imported';
  previewInputStatusEl.textContent = [
    previewInput.label,
    previewInput.mediaType,
    size,
    source,
    getPreviewOutputStatusText()
  ].filter(Boolean).join(' | ');
}

async function syncPreviewInputFile(previewInput) {
  const nextKey = previewInput?.uri ? `${previewInput.uri}|${previewInput.byteLength}` : '';
  if (nextKey === previewInputKey) return;
  stopVideoRenderLoop();
  previewInputKey = nextKey;
  previewInputFile = null;
  revokePreviewInputObjectUrl();
  rawPreviewHost.classList.add('hidden');
  rawPreviewHost.classList.remove('preview-media-host-sampling');
  rawImage.classList.add('hidden');
  rawVideo.classList.add('hidden');
  rawVideo.pause();
  rawImage.removeAttribute('src');
  rawVideo.removeAttribute('src');

  if (!previewInput?.uri) return;
  const response = await fetch(previewInput.uri);
  const blob = await response.blob();
  const type = previewInput.mediaType || blob.type || 'application/octet-stream';
  previewInputFile = new File([blob], previewInput.label || 'preview-input', { type });
  const objectUrl = URL.createObjectURL(previewInputFile);
  previewInputObjectUrl = objectUrl;
  if (previewInput.kind === 'image') {
    rawImage.src = objectUrl;
  } else if (previewInput.kind === 'video') {
    rawVideo.src = objectUrl;
    rawVideo.muted = true;
    rawVideo.loop = true;
    rawVideo.autoplay = true;
    rawVideo.playsInline = true;
    rawVideo.preload = 'auto';
    rawVideo.load();
  }
}

function queueRender() {
  if (isSmallPreviewSuppressed()) {
    stopVideoRenderLoop();
    stopContinuousRenderLoop();
    return;
  }
  renderQueued = true;
  if (renderInFlight) return;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void renderPreview(), 60);
}

function publishParameterValues() {
  if (applyingRemoteState) return;
  vscode.postMessage({
    type: 'parameterValuesChanged',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    values: parameterValues
  });
}

function commitParameterValues() {
  publishParameterValues();
  queueRender();
}

function publishPickerState() {
  if (applyingRemoteState) return;
  vscode.postMessage({
    type: 'pickerStateChanged',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    pointId: selectedNdcPointId,
    rectId: selectedNdcRectId
  });
}

function publishPreviewAspectState() {
  if (applyingRemoteState) return;
  vscode.postMessage({
    type: 'previewAspectChanged',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    previewAspect: previewAspectState
  });
}

async function renderPreview() {
  if (isSmallPreviewSuppressed()) {
    stopVideoRenderLoop();
    return;
  }
  if (!renderQueued || renderInFlight) return;
  renderQueued = false;
  renderInFlight = true;
  try {
    if (!compiledFiles) {
      showRawPreviewOrFallback();
      return;
    }
    const useVideoInput = previewInputFile && isVideoFile(previewInputFile);
    if (useVideoInput) {
      rawImage.classList.add('hidden');
      rawPreviewHost.classList.remove('hidden');
      rawPreviewHost.classList.add('preview-media-host-sampling');
      rawVideo.classList.remove('hidden');
      await ensureVideoReady(rawVideo);
    } else {
      hideRawPreview();
    }
    canvas.classList.remove('hidden');
    const workspace = createWorkspace(sourceFiles);
    const result = await renderFilterPreview({
      compiledFiles,
      workspace,
      canvas,
      parameterValues,
      previewInputFile,
      previewInputVideoElement: useVideoInput ? rawVideo : null,
      previewInputVideoFrameMode: useVideoInput ? 'pixels' : 'external',
      previewOutputAspectRatio: getEffectivePreviewAspectRatio(),
      renderTimeline: nextRenderTimelineSample()
    });
    lastRuntimeOutputSize = { width: result.width, height: result.height };
    setPreviewAspectRatio(result.width, result.height);
    fitPreviewCanvas(result.width, result.height);
    previewStage.dataset.message = '';
    renderPreviewInputStatus(currentState?.previewInput);
    clearRuntimeError();
    const sample = createRuntimeSample(result, ++runtimeSampleIndex);
    runtimeHistory = [...runtimeHistory, sample].slice(-MAX_RUNTIME_HISTORY);
    statusEl.textContent = `Preview rendered. ${formatProfile(result.profile)}`;
    if (useVideoInput) {
      statusEl.textContent = `Preview rendered from video input. ${formatProfile(result.profile)} ${formatVideoProbe()}`;
    }
    updateRuntimeInfo(result, sample, useVideoInput);
    syncVideoRenderLoop();
    syncContinuousRenderLoop();
  } catch (error) {
    stopContinuousRenderLoop();
    canvas.classList.add('hidden');
    previewStage.dataset.message = error?.message || String(error);
    statusEl.textContent = `Preview runtime failed: ${error?.message || error}`;
    runtimeInfoEl.textContent = statusEl.textContent;
    selectDebugTab('runtime');
    publishRuntimeError(error);
  } finally {
    renderInFlight = false;
    if (renderQueued) void renderPreview();
  }
}

function selectDebugTab(tabName) {
  const nextTab = debugPanels[tabName] ? tabName : 'static';
  for (const button of debugTabs) {
    button.classList.toggle('active', button.dataset.debugTab === nextTab);
  }
  for (const [name, panel] of Object.entries(debugPanels)) {
    panel.classList.toggle('active', name === nextTab);
  }
}

function handlePreviewAspectModeChange() {
  const nextMode = PREVIEW_ASPECT_MODES.has(previewAspectSelect.value)
    ? previewAspectSelect.value
    : 'input';
  previewAspectState = normalizePreviewAspectState({
    mode: nextMode,
    custom: previewAspectState.custom
  });
  lastRuntimeOutputSize = null;
  customAspectDraft = formatAspectNumber(previewAspectState.custom);
  renderPreviewAspectControls();
  publishPreviewAspectState();
  renderPreviewInputStatus(currentState?.previewInput);
  queueRender();
  if (nextMode === 'custom') {
    customAspectInput.focus();
    customAspectInput.select();
  }
}

function handleCustomAspectInput() {
  customAspectDraft = customAspectInput.value;
  renderPreviewAspectControls();
  const customValue = parseCustomAspectDraft(customAspectDraft);
  if (customValue === null) return;
  previewAspectState = { mode: 'custom', custom: customValue };
  lastRuntimeOutputSize = null;
  publishPreviewAspectState();
  renderPreviewInputStatus(currentState?.previewInput);
  queueRender();
}

function applyRemotePreviewAspect(value) {
  applyingRemoteState = true;
  try {
    previewAspectState = normalizePreviewAspectState(value);
    customAspectDraft = formatAspectNumber(previewAspectState.custom);
  } finally {
    applyingRemoteState = false;
  }
}

function renderPreviewAspectControls() {
  const available = isPreviewAspectControlAvailable();
  previewAspectControls.classList.toggle('hidden', !available);
  if (!available) return;
  previewAspectSelect.value = previewAspectState.mode;
  const customActive = previewAspectState.mode === 'custom';
  customAspectInput.classList.toggle('hidden', !customActive);
  customAspectError.classList.toggle('hidden', !customActive || isCustomAspectDraftValid(customAspectDraft));
  customAspectInput.classList.toggle('invalid', customActive && !isCustomAspectDraftValid(customAspectDraft));
  customAspectInput.setAttribute('aria-invalid', customActive && !isCustomAspectDraftValid(customAspectDraft) ? 'true' : 'false');
  if (document.activeElement !== customAspectInput) {
    customAspectInput.value = customAspectDraft;
  }
}

function normalizePreviewAspectState(value) {
  const mode = PREVIEW_ASPECT_MODES.has(value?.mode) ? value.mode : 'input';
  const custom = clampCustomAspect(value?.custom);
  return { mode, custom };
}

function clampCustomAspect(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return clampRange(number, CUSTOM_ASPECT_MIN, CUSTOM_ASPECT_MAX);
}

function parseCustomAspectDraft(value) {
  const number = Number(String(value).trim());
  if (!Number.isFinite(number) || number < CUSTOM_ASPECT_MIN || number > CUSTOM_ASPECT_MAX) return null;
  return number;
}

function isCustomAspectDraftValid(value) {
  return parseCustomAspectDraft(value) !== null;
}

function getOutputSizeMode() {
  return currentState?.preview?.manifest?.outputSizeMode ?? 'passive';
}

function isPreviewAspectControlAvailable() {
  return Boolean(currentState?.preview?.ok && getOutputSizeMode() !== 'active');
}

function getEffectivePreviewAspectRatio() {
  if (!isPreviewAspectControlAvailable()) return null;
  if (previewAspectState.mode === 'input') return null;
  if (previewAspectState.mode === 'custom') return previewAspectState.custom;
  return PREVIEW_ASPECT_RATIOS[previewAspectState.mode] ?? null;
}

function getPreviewAspectStatusLabel() {
  if (getOutputSizeMode() === 'active') return 'active';
  if (previewAspectState.mode === 'input') return '按输入';
  if (previewAspectState.mode === 'custom') return `自定义 ${formatAspectNumber(previewAspectState.custom)}`;
  return previewAspectState.mode;
}

function getPreviewOutputStatusText() {
  if (!currentState?.preview?.ok) return '';
  const label = getPreviewAspectStatusLabel();
  if (!lastRuntimeOutputSize) return `Output pending | ${label}`;
  return `Output ${lastRuntimeOutputSize.width}x${lastRuntimeOutputSize.height} | ${label}`;
}

function getRuntimeInfoOutputSize(runtimeInfo) {
  const width = Number(runtimeInfo?.result?.width);
  const height = Number(runtimeInfo?.result?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function formatAspectNumber(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function showRawPreviewOrFallback() {
  stopVideoRenderLoop();
  canvas.classList.add('hidden');
  canvas.style.width = '';
  canvas.style.height = '';
  if (previewInputFile && currentState?.previewInput?.kind === 'image') {
    rawPreviewHost.classList.remove('hidden');
    rawPreviewHost.classList.remove('preview-media-host-sampling');
    rawImage.classList.remove('hidden');
    rawVideo.classList.add('hidden');
    rawVideo.style.width = '';
    rawVideo.style.height = '';
    fitPreviewMedia(rawImage, rawImage.naturalWidth, rawImage.naturalHeight);
    previewStage.dataset.message = '';
    return;
  }
  if (previewInputFile && currentState?.previewInput?.kind === 'video') {
    rawPreviewHost.classList.remove('hidden');
    rawPreviewHost.classList.remove('preview-media-host-sampling');
    rawImage.classList.add('hidden');
    rawImage.style.width = '';
    rawImage.style.height = '';
    rawVideo.classList.remove('hidden');
    void ensureVideoReady(rawVideo).then(() => {
      fitPreviewMedia(rawVideo, rawVideo.videoWidth, rawVideo.videoHeight);
    }).catch(() => {});
    previewStage.dataset.message = '';
    return;
  }
  rawPreviewHost.classList.add('hidden');
  rawPreviewHost.classList.remove('preview-media-host-sampling');
  rawImage.classList.add('hidden');
  rawVideo.classList.add('hidden');
  rawImage.style.width = '';
  rawImage.style.height = '';
  rawVideo.style.width = '';
  rawVideo.style.height = '';
  previewStage.dataset.message = currentState?.preview?.ok === false
    ? (currentState.preview.error || 'Preview failed')
    : 'Run Preview';
}

function hideRawPreview({ keepVideoPlayback = false } = {}) {
  rawImage.classList.add('hidden');

  if (keepVideoPlayback) {
    rawPreviewHost.classList.remove('hidden');
    rawPreviewHost.classList.add('preview-media-host-sampling');
    rawVideo.classList.remove('hidden');
  } else {
    rawPreviewHost.classList.remove('preview-media-host-sampling');
    rawPreviewHost.classList.add('hidden');
    rawVideo.classList.add('hidden');
  }

  if (!keepVideoPlayback) {
    rawVideo.pause();
  }
  canvas.classList.remove('hidden');
}

function setPreviewAspectRatio(width, height) {
  const ratio = Math.max(1, Number(width) || 1) / Math.max(1, Number(height) || 1);
  previewStage.style.setProperty(
    '--preview-aspect-ratio',
    `${Math.max(1, Number(width) || 1)} / ${Math.max(1, Number(height) || 1)}`
  );
  previewStage.style.setProperty('--preview-aspect-ratio-value', String(ratio));
}

function fitPreviewCanvas(width = previewOutputSize?.width, height = previewOutputSize?.height) {
  fitPreviewMedia(canvas, width, height);
}

function refitVisiblePreview() {
  if (!rawImage.classList.contains('hidden') && rawImage.naturalWidth && rawImage.naturalHeight) {
    fitPreviewMedia(rawImage, rawImage.naturalWidth, rawImage.naturalHeight);
    return;
  }
  if (!rawVideo.classList.contains('hidden') && rawVideo.videoWidth && rawVideo.videoHeight) {
    fitPreviewMedia(rawVideo, rawVideo.videoWidth, rawVideo.videoHeight);
    return;
  }
  if (!canvas.classList.contains('hidden')) {
    fitPreviewCanvas();
    return;
  }
  syncNdcPicker();
}

function fitPreviewMedia(element, width = previewOutputSize?.width, height = previewOutputSize?.height) {
  const outputWidth = Math.max(1, Number(width) || 1);
  const outputHeight = Math.max(1, Number(height) || 1);
  previewOutputSize = { width: outputWidth, height: outputHeight };
  setPreviewAspectRatio(outputWidth, outputHeight);
  element.style.aspectRatio = `${outputWidth} / ${outputHeight}`;
  const frame = previewStage.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) {
    requestAnimationFrame(() => fitPreviewMedia(element, outputWidth, outputHeight));
    return;
  }
  const mediaRatio = outputWidth / outputHeight;
  const frameRatio = frame.width / frame.height;
  if (frameRatio > mediaRatio) {
    element.style.height = `${frame.height}px`;
    element.style.width = `${frame.height * mediaRatio}px`;
  } else {
    element.style.width = `${frame.width}px`;
    element.style.height = `${frame.width / mediaRatio}px`;
  }
  syncNdcPicker();
}

function renderParameters(parameters) {
  paramsEl.innerHTML = '';
  paramsEl.classList.toggle('empty', parameters.length === 0);
  if (!parameters.length) {
    paramsEl.textContent = compiledFiles ? 'No parameters.' : 'No preview data.';
    syncNdcPicker();
    return;
  }

  for (const parameter of parameters) {
    const row = document.createElement('div');
    row.className = 'param';
    const header = document.createElement('div');
    header.className = 'param-header';
    const label = document.createElement('label');
    label.textContent = parameter.label || parameter.id;
    const value = document.createElement('span');
    value.className = 'param-value';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'icon-button';
    reset.title = 'Reset to default';
    reset.setAttribute('aria-label', 'Reset to default');
    setButtonIcon(reset, 'reset');
    header.append(label, value, reset);
    row.append(header);
    const resetToDefault = () => {
      parameterValues[parameter.id] = getParameterDefaultValue(parameter);
      renderParameters(parameters);
      commitParameterValues();
    };
    reset.addEventListener('click', resetToDefault);

    if (parameter.type === 'float') {
      const controlRow = document.createElement('div');
      controlRow.className = 'param-control-row';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = parameter.min ?? 0;
      input.max = parameter.max ?? 1;
      input.step = calculateRangeStep(input.min, input.max);
      input.value = parameterValues[parameter.id];
      value.textContent = formatParamValue(parameterValues[parameter.id]);
      input.addEventListener('input', () => {
        parameterValues[parameter.id] = Number(input.value);
        value.textContent = formatParamValue(parameterValues[parameter.id]);
        commitParameterValues();
      });
      const number = document.createElement('input');
      number.type = 'number';
      number.step = input.step;
      number.value = input.value;
      number.addEventListener('input', () => {
        parameterValues[parameter.id] = Number(number.value);
        input.value = number.value;
        value.textContent = formatParamValue(parameterValues[parameter.id]);
        commitParameterValues();
      });
      input.addEventListener('input', () => {
        number.value = input.value;
      });
      controlRow.append(input, number);
      row.append(controlRow);
    } else if (parameter.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'param-bool-toggle';
      input.title = parameter.label || parameter.id;
      input.setAttribute('aria-label', parameter.label || parameter.id);
      input.checked = Boolean(parameterValues[parameter.id]);
      value.replaceWith(input);
      input.addEventListener('change', () => {
        parameterValues[parameter.id] = input.checked;
        commitParameterValues();
      });
    } else if (parameter.type === 'vec4' && isColorVec4Parameter(parameter)) {
      const isColor4 = parameter.semantic === 'color4';
      const channelInputs = Array.from({ length: 4 }, (_, index) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '255';
        input.step = '1';
        input.inputMode = 'numeric';
        input.title = ['Red', 'Green', 'Blue', 'Alpha'][index];
        if (!isColor4 && index === 3) {
          input.disabled = true;
        }
        return input;
      });
      const inputGroup = document.createElement('div');
      inputGroup.className = 'param-color-inputs';
      inputGroup.append(...channelInputs);
      const palette = document.createElement('canvas');
      palette.className = 'param-color-palette';
      palette.width = 256;
      palette.height = 64;
      palette.setAttribute('aria-label', 'Color palette');
      palette.setAttribute('role', 'img');
      let alphaSlider = null;
      if (isColor4) {
        alphaSlider = document.createElement('input');
        alphaSlider.type = 'range';
        alphaSlider.className = 'param-color-alpha';
        alphaSlider.min = '0';
        alphaSlider.max = '255';
        alphaSlider.step = '1';
      }
      const applyColorValue = (nextValue) => {
        const values = normalizeColorVec4Value(nextValue, isColor4);
        const bytes = normalizedColorToBytes(values, isColor4);
        for (let index = 0; index < channelInputs.length; index += 1) {
          channelInputs[index].value = String(bytes[index]);
        }
        if (alphaSlider) {
          alphaSlider.value = String(bytes[3]);
        }
        parameterValues[parameter.id] = values;
        value.textContent = formatColorParamValue(bytes, isColor4);
        drawColorPalette(palette, bytes);
      };
      const readChannelInputBytes = ({ clampValues = true } = {}) => channelInputs.map((input, index) => {
        if (!isColor4 && index === 3) return 255;
        return clampValues ? clampColorByte(input.value) : parseColorByteDraft(input.value);
      });
      const commitChannelInputs = () => {
        applyColorValue(colorBytesToNormalized(readChannelInputBytes({ clampValues: true }), isColor4));
        commitParameterValues();
      };
      const previewChannelInputs = () => {
        const bytes = readChannelInputBytes({ clampValues: false });
        parameterValues[parameter.id] = colorBytesToNormalized(bytes, isColor4);
        value.textContent = formatColorParamValue(bytes, isColor4);
        if (alphaSlider) {
          alphaSlider.value = String(bytes[3]);
        }
        drawColorPalette(palette, bytes);
        commitParameterValues();
      };
      for (const input of channelInputs) {
        input.addEventListener('input', previewChannelInputs);
        input.addEventListener('blur', commitChannelInputs);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            input.blur();
          }
        });
      }
      if (alphaSlider) {
        alphaSlider.addEventListener('input', () => {
          channelInputs[3].value = alphaSlider.value;
          commitChannelInputs();
        });
      }
      const updateFromPalettePointer = (event) => {
        const currentBytes = normalizedColorToBytes(parameterValues[parameter.id], isColor4);
        applyColorValue(colorBytesToNormalized(bytesFromPaletteEvent(palette, event, currentBytes), isColor4));
        commitParameterValues();
      };
      palette.addEventListener('pointerdown', (event) => {
        palette.setPointerCapture?.(event.pointerId);
        updateFromPalettePointer(event);
      });
      palette.addEventListener('pointermove', (event) => {
        if (event.buttons !== 1) return;
        updateFromPalettePointer(event);
      });
      row.append(inputGroup, palette);
      if (alphaSlider) {
        row.append(alphaSlider);
      }
      applyColorValue(parameterValues[parameter.id]);
      requestAnimationFrame(() => drawColorPalette(
        palette,
        normalizedColorToBytes(parameterValues[parameter.id], isColor4)
      ));
    } else if (parameter.type === 'vec4') {
      const isNdcPoint = parameter.semantic === 'ndcPoint2';
      const isNdcRect = parameter.semantic === 'ndcRect';
      const group = document.createElement('div');
      group.className = isNdcPoint ? 'param-ndc-point-row' : isNdcRect ? 'param-ndc-rect-row' : 'vec4-grid';
      const labels = isNdcPoint ? ['x', 'y'] : isNdcRect ? ['x', 'y', 'w', 'h'] : ['x', 'y', 'z', 'w'];
      value.textContent = isNdcPoint
        ? formatNdcPointValue(parameterValues[parameter.id])
        : isNdcRect
          ? formatNdcRectValue(parameterValues[parameter.id])
          : formatVec4ParamValue(parameterValues[parameter.id]);
      labels.forEach((axis, index) => {
        const shell = document.createElement('label');
        shell.textContent = axis;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        if (isNdcRect && index >= 2) input.min = '0';
        input.value = parameterValues[parameter.id][index];
        input.addEventListener('input', () => {
          const next = [...parameterValues[parameter.id]];
          next[index] = Number(input.value || 0);
          parameterValues[parameter.id] = isNdcPoint
            ? normalizeNdcPoint2Value(next)
            : isNdcRect
              ? normalizeNdcRectValue(next)
              : normalizeVec4Value(next);
          value.textContent = isNdcPoint
            ? formatNdcPointValue(parameterValues[parameter.id])
            : isNdcRect
              ? formatNdcRectValue(parameterValues[parameter.id])
              : formatVec4ParamValue(parameterValues[parameter.id]);
          syncNdcPicker();
          commitParameterValues();
        });
        shell.append(input);
        group.append(shell);
      });
      if (isNdcPoint || isNdcRect) {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'secondary param-pick-button';
        pick.title = isNdcRect ? 'Draw rectangle in preview' : 'Select preview picker';
        pick.setAttribute('aria-label', pick.title);
        const isActive = isNdcPoint ? selectedNdcPointId === parameter.id : selectedNdcRectId === parameter.id;
        pick.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        setButtonIcon(pick, isNdcRect ? 'rectPick' : 'pick');
        pick.addEventListener('click', () => {
          if (isNdcPoint) {
            selectedNdcPointId = selectedNdcPointId === parameter.id ? '' : parameter.id;
            selectedNdcRectId = '';
          } else {
            selectedNdcRectId = selectedNdcRectId === parameter.id ? '' : parameter.id;
            selectedNdcPointId = '';
          }
          ndcRectDragStart = null;
          publishPickerState();
          renderParameters(parameters);
          syncNdcPicker();
        });
        group.append(pick);
      }
      row.append(group);
    } else {
      value.textContent = JSON.stringify(parameterValues[parameter.id] ?? null);
    }

    paramsEl.append(row);
  }
  syncNdcPicker();
}

function syncParameterValues(parameters) {
  const nextValues = {};
  for (const parameter of parameters) {
    nextValues[parameter.id] = Object.prototype.hasOwnProperty.call(parameterValues, parameter.id)
      ? normalizeParameterValue(parameter, parameterValues[parameter.id])
      : getParameterDefaultValue(parameter);
  }
  parameterValues = nextValues;
}

function applyRemoteParameterValues(values) {
  if (!values || typeof values !== 'object') return;
  applyingRemoteState = true;
  try {
    for (const parameter of currentState?.preview?.manifest?.parameters ?? []) {
      if (!Object.prototype.hasOwnProperty.call(values, parameter.id)) continue;
      parameterValues[parameter.id] = normalizeParameterValue(parameter, values[parameter.id]);
    }
  } finally {
    applyingRemoteState = false;
  }
}

function decodeFileMap(encoded) {
  const files = {};
  for (const [name, value] of Object.entries(encoded ?? {})) {
    if (value?.encoding === 'base64') {
      files[name] = base64ToBytes(value.data);
    } else {
      files[name] = value;
    }
  }
  return files;
}

function base64ToBytes(value) {
  const binary = atob(value || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createWorkspace(files) {
  return {
    getFile(filePath) {
      const content = files?.[normalizePath(filePath)];
      return content === undefined ? null : { path: normalizePath(filePath), content };
    }
  };
}

function normalizePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function calculateRangeStep(min, max) {
  const span = Math.abs(Number(max) - Number(min));
  if (span >= 10) return 0.1;
  if (span >= 1) return 0.01;
  return 0.001;
}

function normalizeParameterValue(parameter, value) {
  if (parameter.type === 'float') return Number.isFinite(Number(value)) ? Number(value) : getParameterDefaultValue(parameter);
  if (parameter.type === 'bool') return Boolean(value);
  if (parameter.type === 'vec4' && parameter.semantic === 'ndcPoint2') return normalizeNdcPoint2Value(value);
  if (parameter.type === 'vec4' && parameter.semantic === 'ndcRect') return normalizeNdcRectValue(value);
  if (parameter.type === 'vec4' && isColorVec4Parameter(parameter)) return normalizeColorVec4Value(value, parameter.semantic === 'color4');
  if (parameter.type === 'vec4') return normalizeVec4Value(value);
  return value ?? getParameterDefaultValue(parameter);
}

function getParameterDefaultValue(parameter) {
  if (parameter.type === 'float') return parameter.default ?? parameter.min ?? 0;
  if (parameter.type === 'bool') return parameter.default ?? false;
  if (parameter.type === 'vec4' && parameter.semantic === 'ndcPoint2') return normalizeNdcPoint2Value(parameter.default);
  if (parameter.type === 'vec4' && parameter.semantic === 'ndcRect') return normalizeNdcRectValue(parameter.default);
  if (parameter.type === 'vec4' && isColorVec4Parameter(parameter)) return normalizeColorVec4Value(parameter.default, parameter.semantic === 'color4');
  if (parameter.type === 'vec4') return normalizeVec4Value(parameter.default);
  return parameter.default ?? null;
}

function normalizeVec4Value(value) {
  const values = Array.isArray(value) ? value : [];
  return Array.from({ length: 4 }, (_, index) => Number(values[index] ?? 0));
}

function normalizeNdcPoint2Value(value) {
  const values = Array.isArray(value) ? value : [];
  return [
    clampRange(values[0] ?? 0, -1, 1),
    clampRange(values[1] ?? 0, -1, 1),
    0,
    1
  ];
}

function normalizeNdcRectValue(value) {
  const values = Array.isArray(value) ? value : [];
  return [
    Number(values[0] ?? -0.5),
    Number(values[1] ?? -0.5),
    Math.max(0, Number(values[2] ?? 1)),
    Math.max(0, Number(values[3] ?? 1))
  ];
}

function isColorVec4Parameter(parameter) {
  return parameter.semantic === 'color3' || parameter.semantic === 'color4';
}

function normalizeColorVec4Value(value, isColor4) {
  const values = normalizeVec4Value(value).map((item) => clampRange(item, 0, 1));
  if (!isColor4) {
    values[3] = 1;
  }
  return values;
}

function colorBytesToNormalized(bytes, isColor4) {
  const values = Array.from({ length: 4 }, (_, index) => clampColorByte(bytes[index]) / 255);
  if (!isColor4) {
    values[3] = 1;
  }
  return values;
}

function normalizedColorToBytes(value, isColor4) {
  const values = normalizeColorVec4Value(value, isColor4);
  return values.map((item, index) => !isColor4 && index === 3 ? 255 : Math.round(clampRange(item, 0, 1) * 255));
}

function formatColorParamValue(bytes, isColor4) {
  return isColor4
    ? `rgba(${bytes[0]}, ${bytes[1]}, ${bytes[2]}, ${bytes[3]})`
    : `rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`;
}

function bytesFromPaletteEvent(canvas, event, currentBytes) {
  const rect = canvas.getBoundingClientRect();
  const x = clampRange((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  const y = clampRange((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
  const [red, green, blue] = hslToRgbBytes(x * 360, 1, 1 - y);
  return [red, green, blue, currentBytes?.[3] ?? 255];
}

function drawColorPalette(canvas, selectedBytes) {
  syncCanvasBackingSize(canvas);
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  const hueGradient = context.createLinearGradient(0, 0, width, 0);
  for (let hue = 0; hue <= 360; hue += 60) {
    hueGradient.addColorStop(hue / 360, `hsl(${hue} 100% 50%)`);
  }
  context.fillStyle = hueGradient;
  context.fillRect(0, 0, width, height);

  const shadeGradient = context.createLinearGradient(0, 0, 0, height);
  shadeGradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  shadeGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  shadeGradient.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
  context.fillStyle = shadeGradient;
  context.fillRect(0, 0, width, height);

  const [hue, , lightness] = rgbBytesToHsl(selectedBytes[0], selectedBytes[1], selectedBytes[2]);
  const x = (hue / 360) * width;
  const y = (1 - lightness) * height;
  context.strokeStyle = '#fff';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x, y, 5, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  context.lineWidth = 1;
  context.beginPath();
  context.arc(x, y, 6, 0, Math.PI * 2);
  context.stroke();
}

function syncCanvasBackingSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round((rect.width || canvas.clientWidth || 256) * pixelRatio));
  const height = Math.max(1, Math.round((rect.height || canvas.clientHeight || 48) * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function hslToRgbBytes(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (huePrime >= 0 && huePrime < 1) [red, green, blue] = [chroma, x, 0];
  else if (huePrime < 2) [red, green, blue] = [x, chroma, 0];
  else if (huePrime < 3) [red, green, blue] = [0, chroma, x];
  else if (huePrime < 4) [red, green, blue] = [0, x, chroma];
  else if (huePrime < 5) [red, green, blue] = [x, 0, chroma];
  else [red, green, blue] = [chroma, 0, x];
  const match = lightness - chroma / 2;
  return [red, green, blue].map((item) => clampColorByte((item + match) * 255));
}

function rgbBytesToHsl(redByte, greenByte, blueByte) {
  const red = clampColorByte(redByte) / 255;
  const green = clampColorByte(greenByte) / 255;
  const blue = clampColorByte(blueByte) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (max === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return [(hue + 360) % 360, saturation, lightness];
}

function clampColorByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(255, number)));
}

function parseColorByteDraft(value) {
  if (String(value).trim() === '') return 0;
  return clampColorByte(value);
}

function formatParamValue(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function formatVec4ParamValue(value) {
  return `[${normalizeVec4Value(value).map((item) => formatParamValue(item)).join(', ')}]`;
}

function formatNdcPointValue(value) {
  const values = normalizeNdcPoint2Value(value);
  return `(${formatParamValue(values[0])}, ${formatParamValue(values[1])})`;
}

function formatNdcRectValue(value) {
  const values = normalizeNdcRectValue(value);
  return `[${values.map((item) => formatParamValue(item)).join(', ')}]`;
}

function clampRange(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function isVideoFile(file) {
  return file?.type?.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file?.name ?? '');
}

function shouldRenderVideoFrames() {
  return Boolean(!isSmallPreviewSuppressed() && compiledFiles && previewInputFile && isVideoFile(previewInputFile));
}

function getFrameInvalidationMode() {
  return currentState?.preview?.manifest?.runtimeHints?.frameInvalidation ?? 'onChange';
}

function shouldRenderContinuousFrames() {
  return Boolean(
    !isSmallPreviewSuppressed()
    && compiledFiles
    && getFrameInvalidationMode() === 'continuous'
    && !(previewInputFile && isVideoFile(previewInputFile))
  );
}

function isSmallPreviewSuppressed() {
  return document.body.dataset.viewMode === 'sidebar' && document.body.classList.contains('large-preview-open');
}

function syncVideoRenderLoop() {
  if (shouldRenderVideoFrames()) {
    startVideoRenderLoop();
    return;
  }
  stopVideoRenderLoop();
}

function syncContinuousRenderLoop() {
  if (shouldRenderContinuousFrames()) {
    startContinuousRenderLoop();
    return;
  }
  stopContinuousRenderLoop();
}

function startVideoRenderLoop() {
  if (videoRenderFrameId) return;
  const tick = () => {
    videoRenderFrameId = 0;
    if (!shouldRenderVideoFrames()) return;
    renderQueued = true;
    if (!renderInFlight) void renderPreview();
    videoRenderFrameId = requestAnimationFrame(tick);
  };
  videoRenderFrameId = requestAnimationFrame(tick);
}

function stopVideoRenderLoop() {
  if (!videoRenderFrameId) return;
  cancelAnimationFrame(videoRenderFrameId);
  videoRenderFrameId = 0;
}

function startContinuousRenderLoop() {
  if (continuousRenderFrameId) return;
  const tick = (timestamp) => {
    continuousRenderFrameId = 0;
    if (!shouldRenderContinuousFrames()) return;
    if (timestamp - lastContinuousRenderMs >= CONTINUOUS_RENDER_INTERVAL_MS) {
      lastContinuousRenderMs = timestamp;
      renderQueued = true;
      if (!renderInFlight) void renderPreview();
    }
    continuousRenderFrameId = requestAnimationFrame(tick);
  };
  continuousRenderFrameId = requestAnimationFrame(tick);
}

function stopContinuousRenderLoop() {
  if (!continuousRenderFrameId) return;
  cancelAnimationFrame(continuousRenderFrameId);
  continuousRenderFrameId = 0;
}

function formatVideoProbe() {
  const sample = sampleVideoFrame();
  if (!sample) return '';
  return `video sample ${sample.width}x${sample.height} t=${sample.time}s luma=${sample.luma}`;
}

function sampleVideoFrame() {
  if (!videoProbeContext || !rawVideo.videoWidth || !rawVideo.videoHeight) return null;
  const width = 24;
  const height = 14;
  if (videoProbeCanvas.width !== width) videoProbeCanvas.width = width;
  if (videoProbeCanvas.height !== height) videoProbeCanvas.height = height;
  videoProbeContext.drawImage(rawVideo, 0, 0, width, height);
  const data = videoProbeContext.getImageData(0, 0, width, height).data;
  let total = 0;
  for (let index = 0; index < data.length; index += 4) {
    total += (data[index] + data[index + 1] + data[index + 2]) / 3;
  }
  return {
    width: rawVideo.videoWidth,
    height: rawVideo.videoHeight,
    time: rawVideo.currentTime.toFixed(2),
    luma: (total / (data.length / 4)).toFixed(1)
  };
}

function updateRuntimeInfo(result, sample, useVideoInput) {
  const now = performance.now();
  if (useVideoInput && now - lastRuntimeInfoUpdateMs < VIDEO_RUNTIME_INFO_UPDATE_INTERVAL_MS) {
    return;
  }
  lastRuntimeInfoUpdateMs = now;
  runtimeInfoEl.innerHTML = formatRuntimeInfo(result, sample, runtimeHistory, activeRuntimeTab);
  vscode.postMessage({
    type: 'runtimeInfoChanged',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    ...createRuntimeSyncPayload(result, sample)
  });
}

function publishRuntimeError(error) {
  const message = error?.message || String(error);
  const key = `${currentState?.currentRoot || ''}|${message}`;
  runtimeErrorKey = key;
  vscode.postMessage({
    type: 'runtimeErrorChanged',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    projectRoot: currentState?.currentRoot || '',
    message
  });
}

function clearRuntimeError() {
  if (!runtimeErrorKey) return;
  runtimeErrorKey = '';
  vscode.postMessage({
    type: 'runtimeErrorCleared',
    viewMode: document.body.dataset.viewMode || 'sidebar',
    projectRoot: currentState?.currentRoot || ''
  });
}

function applyRemoteRuntimeInfo(runtimeInfo) {
  if (!isSmallPreviewSuppressed() || !runtimeInfo?.result || !runtimeInfo?.sample) return;
  lastRuntimeOutputSize = getRuntimeInfoOutputSize(runtimeInfo);
  renderPreviewInputStatus(currentState?.previewInput);
  runtimeInfoEl.innerHTML = formatRuntimeInfo(
    runtimeInfo.result,
    runtimeInfo.sample,
    Array.isArray(runtimeInfo.history) ? runtimeInfo.history : [runtimeInfo.sample],
    activeRuntimeTab
  );
  if (runtimeInfo.status) {
    statusEl.textContent = runtimeInfo.status;
  }
}

function createRuntimeSyncPayload(result, sample) {
  return {
    result: {
      width: result?.width ?? 0,
      height: result?.height ?? 0,
      profile: result?.profile ?? null,
      diagnostics: result?.diagnostics ?? [],
      debugSnapshot: result?.debugSnapshot ?? null
    },
    sample,
    history: runtimeHistory,
    status: statusEl.textContent
  };
}

async function ensureVideoReady(video) {
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.autoplay = true;
  await video.play().catch(() => {});
  if ((video.readyState ?? 0) >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for preview video.')), 8000);
    const done = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('error', fail);
      reject(new Error('Failed to load preview video.'));
    };
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('canplay', done, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
  await video.play().catch(() => {});
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatProfile(profile) {
  if (!profile?.totalMs) return '';
  return `Runtime ${profile.totalMs.toFixed(1)}ms`;
}

function syncNdcPicker() {
  const pointValue = selectedNdcPointId ? parameterValues[selectedNdcPointId] : null;
  const rectValue = selectedNdcRectId ? parameterValues[selectedNdcRectId] : null;
  const active = Boolean(pointValue || rectValue);
  pickLayer.classList.toggle('hidden', !active);
  previewHandle.classList.toggle('hidden', !pointValue);
  previewRect.classList.toggle('hidden', !rectValue);
  if (!active) return;
  const stageRect = previewStage.getBoundingClientRect();
  const contentRect = getPreviewContentRect();
  if (rectValue) {
    const rect = normalizeNdcRectValue(rectValue);
    const left = contentRect.left - stageRect.left + ((rect[0] + 1) / 2) * contentRect.width;
    const top = contentRect.top - stageRect.top + ((rect[1] + 1) / 2) * contentRect.height;
    const width = (rect[2] / 2) * contentRect.width;
    const height = (rect[3] / 2) * contentRect.height;
    previewRect.style.left = `${left}px`;
    previewRect.style.top = `${top}px`;
    previewRect.style.width = `${width}px`;
    previewRect.style.height = `${height}px`;
    return;
  }
  if (!pointValue) return;
  const point = normalizeNdcPoint2Value(pointValue);
  const x = contentRect.left - stageRect.left + ((point[0] + 1) / 2) * contentRect.width;
  const y = contentRect.top - stageRect.top + ((point[1] + 1) / 2) * contentRect.height;
  previewHandle.style.left = `${x}px`;
  previewHandle.style.top = `${y}px`;
}

function applyNdcPointFromPointer(event) {
  const [ndcX, ndcY] = pointerToNdc(event);
  parameterValues[selectedNdcPointId] = [
    ndcX,
    ndcY,
    0,
    1
  ];
  renderParameters(currentState?.preview?.manifest?.parameters ?? []);
  commitParameterValues();
}

function applyNdcRectFromPointer(event) {
  if (!selectedNdcRectId || !ndcRectDragStart) return;
  const [endX, endY] = pointerToNdc(event);
  const [startX, startY] = ndcRectDragStart;
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  parameterValues[selectedNdcRectId] = [
    left,
    top,
    Math.abs(endX - startX),
    Math.abs(endY - startY)
  ];
  renderParameters(currentState?.preview?.manifest?.parameters ?? []);
  commitParameterValues();
}

function pointerToNdc(event) {
  const rect = getPreviewContentRect();
  const x = clampRange((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  const y = clampRange((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
  return [
    x * 2 - 1,
    y * 2 - 1
  ];
}

function getPreviewContentRect() {
  const visibleMedia = [canvas, rawImage, rawVideo].find((item) => !item.classList.contains('hidden'));
  const rect = visibleMedia?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) return rect;
  return previewStage.getBoundingClientRect();
}

function formatStaticInfo(manifest, outputFiles) {
  if (!manifest) return 'No compile data.';
  const passes = manifest.passes ?? [];
  const assets = manifest.assets ?? [];
  return [
    '<div class="summary-grid">',
    summaryPill('Runtime Schema', manifest.runtimeVersion ?? 'unknown'),
    summaryPill('Output Mode', manifest.outputSizeMode ?? 'passive'),
    summaryPill('Passes', passes.length),
    summaryPill('Params', (manifest.parameters ?? []).length),
    '</div>',
    assets.length ? infoSection('Assets', assets.map((asset) => infoRow(
      asset.id ?? asset.name ?? 'asset',
      asset.path ?? asset.src ?? 'no path'
    )).join('')) : '',
    infoSection('Passes', passes.map((pass) => {
      const stages = Object.entries(pass.stages ?? {})
        .map(([stage, stagePath]) => `${escapeHtml(stage)}: ${escapeHtml(stagePath)}`)
        .join('<br>');
      const bindings = (pass.bindings ?? []).map((binding) => {
        const head = [
          binding.name,
          `set ${binding.set ?? 0}`,
          `binding ${binding.binding}`,
          binding.type,
          binding.access,
          binding.elementType
        ].filter(Boolean).join(', ');
        const fields = (binding.fields ?? [])
          .map((field) => `${field.name}:${field.type}@${field.offset ?? 0}`)
          .join(' | ');
        return `<div class="info-sub">${escapeHtml(head)}${fields ? `<br>${escapeHtml(fields)}` : ''}</div>`;
      }).join('');
      return [
        infoRow(pass.id ?? 'pass', pass.type ?? 'unknown'),
        stages ? `<div class="info-sub">${stages}</div>` : '',
        bindings ? `<div class="info-section"><div class="info-section-title">Bindings</div>${bindings}</div>` : ''
      ].join('');
    }).join('')),
    outputFiles?.length ? infoSection('Compiled Files', outputFiles.slice(0, 12).map((name) => `<div class="info-sub">${escapeHtml(name)}</div>`).join('')) : ''
  ].filter(Boolean).join('');
}

function createRuntimeSample(result, index) {
  const profile = result?.profile;
  const sections = Array.isArray(profile?.sections) ? profile.sections : [];
  const passSections = sections.filter((section) => section.name?.startsWith('pass:'));
  const luaSections = sections.filter((section) => section.name?.startsWith('lua'));
  const passTotal = sumSectionMs(passSections);
  const luaTotal = sumSectionMs(luaSections);
  const passExecutionOrder = createPassExecutionOrder(result?.debugSnapshot?.queuedPasses);
  return {
    index,
    totalMs: Number(profile?.totalMs ?? 0),
    luaTotal,
    passTotal,
    passSections: passSections
      .map((section, profileOrder) => ({
        label: section.name.replace(/^pass:/, ''),
        totalMs: Number(section.totalMs ?? 0),
        count: section.count ?? 1,
        executionOrder: passExecutionOrder.get(getProfilePassId(section.name)) ?? Number.MAX_SAFE_INTEGER,
        profileOrder
      }))
      .sort((left, right) => left.executionOrder - right.executionOrder || left.profileOrder - right.profileOrder)
  };
}

function createPassExecutionOrder(queuedPasses) {
  const order = new Map();
  for (const command of queuedPasses ?? []) {
    if (!command?.passId || order.has(command.passId)) continue;
    order.set(command.passId, order.size);
  }
  return order;
}

function getProfilePassId(sectionName) {
  const match = /^pass:([^:]+):/.exec(String(sectionName ?? ''));
  return match?.[1] ?? '';
}

function formatRuntimeInfo(result, latest = createRuntimeSample(result, 1), history = [latest], activeTab = 'trend') {
  const metricRows = [
    { label: 'Lua total', totalMs: latest.luaTotal, count: 1 },
    ...latest.passSections
  ];
  const maxMs = Math.max(1, ...metricRows.map((row) => row.totalMs));
  const diagnostics = formatRuntimeDiagnostics(result?.diagnostics ?? []);
  const debug = formatRuntimeDebugSnapshot(result?.debugSnapshot);
  const detailLines = [
    `Preview total: ${formatMs(latest.totalMs)}`,
    `Lua total: ${formatMs(latest.luaTotal)}`,
    `Pass sum: ${formatMs(latest.passTotal)}`,
    `Output: ${result?.width ?? 0}x${result?.height ?? 0}`,
    '',
    'Pass timings:',
    ...(latest.passSections.length
      ? latest.passSections.map((row) => `  ${row.label}: ${formatMs(row.totalMs)}${row.count > 1 ? ` (${row.count}x)` : ''}`)
      : ['  No pass timings recorded.'])
  ].join('\n');
  const safeActiveTab = ['trend', 'breakdown', 'details'].includes(activeTab) ? activeTab : 'trend';
  return [
    '<div class="runtime-inspector">',
    '<div class="summary-grid">',
    summaryPill('Preview', formatMs(latest.totalMs)),
    summaryPill('Output', `${result?.width ?? 0}x${result?.height ?? 0}`),
    summaryPill('Lua', formatMs(latest.luaTotal)),
    summaryPill('Pass Sum', formatMs(latest.passTotal)),
    '</div>',
    '<div class="runtime-subtabs" role="tablist" aria-label="Runtime views">',
    runtimeTabButton('trend', 'Trend', safeActiveTab),
    runtimeTabButton('breakdown', 'Breakdown', safeActiveTab),
    runtimeTabButton('details', 'Details', safeActiveTab),
    '</div>',
    runtimePanel('trend', safeActiveTab, buildRuntimeTrendChart(history)),
    runtimePanel('breakdown', safeActiveTab, infoSection('Current Pass Breakdown', metricRows.length
      ? metricRows.map((row) => metricRow(row, maxMs)).join('')
      : '<div class="info-sub">No runtime sections recorded.</div>')),
    runtimePanel('details', safeActiveTab, [
      infoSection('Details', `<pre class="details-pre">${escapeHtml(detailLines)}</pre>`),
      diagnostics ? infoSection('Diagnostics', `<pre class="details-pre">${escapeHtml(diagnostics)}</pre>`) : '',
      debug ? infoSection('Debug Snapshot', `<pre class="details-pre">${escapeHtml(debug)}</pre>`) : ''
    ].filter(Boolean).join('')),
    '</div>'
  ].filter(Boolean).join('');
}

function runtimeTabButton(id, label, activeTab) {
  return `<button class="runtime-subtab ${activeTab === id ? 'active' : ''}" type="button" data-runtime-tab="${id}">${escapeHtml(label)}</button>`;
}

function runtimePanel(id, activeTab, body) {
  return `<div class="runtime-subtab-panel ${activeTab === id ? 'active' : ''}" data-runtime-panel="${id}">${body}</div>`;
}

function buildRuntimeTrendChart(history) {
  const samples = history.slice(-MAX_RUNTIME_HISTORY);
  if (!samples.length) {
    return '<div class="info-sub">No runtime samples recorded.</div>';
  }
  const width = 260;
  const height = 92;
  const pad = 14;
  const maxMs = Math.max(1, ...samples.flatMap((sample) => [sample.totalMs, sample.luaTotal, sample.passTotal]));
  const pointsFor = (key) => samples.map((sample, index) => {
    const x = samples.length === 1
      ? width - pad
      : pad + (index / (samples.length - 1)) * (width - pad * 2);
    const y = height - pad - (Number(sample[key] ?? 0) / maxMs) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
    <svg class="runtime-trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Runtime trend">
      <line class="runtime-chart-grid" x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}"></line>
      <line class="runtime-chart-grid" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line>
      <polyline class="runtime-chart-line" points="${pointsFor('totalMs')}" stroke="#4fc1ff"></polyline>
      <polyline class="runtime-chart-line" points="${pointsFor('luaTotal')}" stroke="#f2cc60"></polyline>
      <polyline class="runtime-chart-line" points="${pointsFor('passTotal')}" stroke="#7ee787"></polyline>
      <text class="runtime-chart-label" x="${pad}" y="10">max ${escapeHtml(formatMs(maxMs))}</text>
      <text class="runtime-chart-label" x="${pad}" y="${height - 3}">total blue · lua yellow · pass green</text>
    </svg>
  `;
}

function summaryPill(label, value) {
  return `<div class="summary-pill"><span class="summary-label">${escapeHtml(label)}</span><span class="summary-value">${escapeHtml(value)}</span></div>`;
}

function infoSection(title, body) {
  if (!body) return '';
  return `<div class="info-section"><div class="info-section-title">${escapeHtml(title)}</div>${body}</div>`;
}

function infoRow(name, value) {
  return `<div class="info-row"><span class="info-name">${escapeHtml(name)}</span><span class="info-sub">${escapeHtml(value)}</span></div>`;
}

function metricRow(row, maxMs) {
  const ratio = Math.max(2, Math.min(100, (Number(row.totalMs ?? 0) / maxMs) * 100));
  return `
    <div class="info-row">
      <span class="info-name">${escapeHtml(row.label)}</span>
      <span class="info-sub">${formatMs(row.totalMs)}${row.count > 1 ? ` x${row.count}` : ''}</span>
    </div>
    <div class="metric-bar"><span style="width:${ratio}%"></span></div>
  `;
}

function formatRuntimeDiagnostics(diagnostics) {
  return diagnostics
    .filter((diagnostic) => /WebGPU|webgpu|render pass|uncaptured|uniform|warning|error/i.test(diagnostic.message || diagnostic.level || ''))
    .slice(-8)
    .map((diagnostic) => {
      const details = Object.entries(diagnostic.details ?? {})
        .map(([key, value]) => `    ${key}: ${formatDiagnosticDetail(value)}`)
        .join('\n');
      return `  [${diagnostic.level || 'info'}] ${diagnostic.message || ''}${details ? `\n${details}` : ''}`;
    })
    .join('\n');
}

function formatDiagnosticDetail(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRuntimeDebugSnapshot(snapshot) {
  if (!snapshot) return '';
  const lines = [];
  if (Array.isArray(snapshot.queuedPasses) && snapshot.queuedPasses.length) {
    lines.push('Queued passes:');
    for (const pass of snapshot.queuedPasses) {
      lines.push(`  ${pass.type}: ${pass.passId}`);
    }
  }
  if (Array.isArray(snapshot.buffers) && snapshot.buffers.length) {
    lines.push('Buffers:');
    for (const buffer of snapshot.buffers) {
      lines.push(`  ${buffer.id} [${buffer.elementType}] shape=${formatShape(buffer.shape)} count=${buffer.count ?? 0} residency=${buffer.residency ?? 'unknown'}`);
    }
  }
  return lines.join('\n');
}

function sumSectionMs(sections) {
  return sections.reduce((total, section) => total + Number(section.totalMs ?? 0), 0);
}

function formatMs(value) {
  const number = Number(value ?? 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)}s`;
  if (number >= 10) return `${number.toFixed(1)}ms`;
  return `${number.toFixed(2)}ms`;
}

function formatShape(shape) {
  return Array.isArray(shape) ? `[${shape.join(', ')}]` : '[]';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setButtonIcon(button, name) {
  button.innerHTML = iconSvg(name);
}

function iconSvg(name) {
  const icons = {
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><circle cx="12" cy="12" r="4"/></svg>',
    rectPick: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="10" rx="1"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg>'
  };
  return icons[name] ?? '';
}

function revokePreviewInputObjectUrl() {
  if (!previewInputObjectUrl) return;
  URL.revokeObjectURL(previewInputObjectUrl);
  previewInputObjectUrl = '';
}
