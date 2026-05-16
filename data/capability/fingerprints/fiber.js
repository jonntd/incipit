export const REACT_FIBER_KEY_PREFIX = '__reactFiber';

export function reactFiberKeyForElement(el) {
  if (!el) return null;
  try {
    return Object.keys(el).find(key => key.startsWith(REACT_FIBER_KEY_PREFIX)) || null;
  } catch (_) {
    return null;
  }
}

export function reactFiberForElement(el) {
  const key = reactFiberKeyForElement(el);
  return key ? el[key] : null;
}
