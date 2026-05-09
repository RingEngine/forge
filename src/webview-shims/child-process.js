export function execSync() {
  throw new Error('Child processes are unavailable in the Forge webview runtime.');
}

export function spawnSync() {
  throw new Error('Child processes are unavailable in the Forge webview runtime.');
}

export default {
  execSync,
  spawnSync
};
