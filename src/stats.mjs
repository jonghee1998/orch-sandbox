export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError('values must contain only finite numbers');
    }
    sum += v;
  }
  return sum / values.length;
}
