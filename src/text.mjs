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
