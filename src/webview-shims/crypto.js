export function randomBytes() {
  throw new Error('Crypto random bytes are unavailable in the Forge webview runtime.');
}

export default {
  randomBytes
};
