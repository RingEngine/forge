export function resolve(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

export function join(...parts) {
  return resolve(...parts);
}

export function dirname(path) {
  const value = String(path ?? '').replace(/\\/g, '/');
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(0, index) || '/' : '.';
}

export function basename(path) {
  const value = String(path ?? '').replace(/\\/g, '/');
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

export default {
  resolve,
  join,
  dirname,
  basename
};
