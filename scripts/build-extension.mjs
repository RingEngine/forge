import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vscode', 'naga-wasi-cli'],
  outfile: 'dist/extension.js',
  logLevel: 'info',
});
