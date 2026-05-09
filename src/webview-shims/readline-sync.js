export function setDefaultOptions() {
}

export function prompt() {
  return 'cont';
}

export function question() {
  throw new Error('Synchronous terminal input is unavailable in the Forge webview runtime.');
}

export default {
  setDefaultOptions,
  prompt,
  question
};
