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

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError('values must contain only finite numbers');
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
