// Sample library used to exercise the orchestrator end to end.

/** Count words separated by whitespace. */
export function wordCount(text) {
  const t = String(text ?? "").trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Count characters by Unicode code point. Non-strings return 0. */
export function charCount(text, { ignoreSpaces = false } = {}) {
  if (typeof text !== "string") return 0;
  const s = ignoreSpaces ? text.replace(/\s+/gu, "") : text;
  return Array.from(s).length;
}

/** Top n most frequent words (lowercased, punctuation stripped). Ties sorted alphabetically. */
export function topWords(text, n = 3) {
  if (!Number.isInteger(n) || n <= 0) return [];
  if (typeof text !== "string") return [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, n);
}
