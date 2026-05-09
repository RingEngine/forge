import { build } from 'esbuild';

await build({
  entryPoints: ['src/webview-entry.js'],
  bundle: true,
  format: 'esm',
  target: 'chrome118',
  outfile: 'dist/webview.js',
  alias: {
    os: './src/webview-shims/os.js',
    fs: './src/webview-shims/fs.js',
    path: './src/webview-shims/path.js',
    child_process: './src/webview-shims/child-process.js',
    crypto: './src/webview-shims/crypto.js',
    tmp: './src/webview-shims/tmp.js',
    'readline-sync': './src/webview-shims/readline-sync.js'
  },
  banner: {
    js: `
const __forgeProcess = globalThis.process ?? {
  env: {},
  platform: 'browser',
  versions: { node: '18.0.0' },
  pid: 1,
  cwd: () => '/',
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  addListener: () => {},
  removeListener: () => {},
  stdin: { fd: 0 },
  stdout: { fd: 1, write: () => true },
  stderr: { fd: 2, write: () => true }
};
globalThis.process = __forgeProcess;
globalThis.global = globalThis.global ?? globalThis;
var process = __forgeProcess;
var global = globalThis.global;
var Buffer = globalThis.Buffer ?? {
  from(value) {
    return {
      toString() {
        return String(value ?? '');
      }
    };
  }
};
try {
  globalThis.__forgeWebviewBoot = globalThis.__forgeWebviewBoot ?? {};
  globalThis.__forgeWebviewBoot.bundleEntered = true;
  const status = globalThis.document?.getElementById?.('status');
  if (status) status.textContent = 'Webview bundle entered. Initializing...';
  globalThis.__forgeWebviewReport?.({
    type: 'webviewDiagnostic',
    stage: 'bundle',
    detail: 'bundle entered'
  });
} catch {
}
`
  },
  logLevel: 'info'
});
