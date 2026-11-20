// Sample library used to exercise the orchestrator end to end.

/** Count words separated by whitespace. */
export function wordCount(text) {
  const t = String(text ?? "").trim();
  return t ? t.split(/\s+/).length : 0;
}
