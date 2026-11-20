const LABELS = new Map([
  ['admin', '관리자'],
  ['editor', '편집자'],
  ['viewer', '열람자'],
]);

export function roleLabel(role) {
  return typeof role === 'string' && LABELS.has(role) ? LABELS.get(role) : '알 수 없음';
}
