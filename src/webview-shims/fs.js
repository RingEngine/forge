export function readFileSync() {
  throw new Error('File system access is unavailable in the Forge webview runtime.');
}

export default {
  readFileSync
};
