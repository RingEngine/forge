export function tmpNameSync() {
  throw new Error('Temporary files are unavailable in the Forge webview runtime.');
}

export default {
  tmpNameSync
};
