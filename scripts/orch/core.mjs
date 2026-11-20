// Orchestrator core: pure functions only (no I/O). Easy to unit-test.
//
// Model
// - Run = one GitHub Issue. The issue body holds the plan (first ```json block),
//   a human-readable board, and a machine state marker <!-- orch-state:v1 {...} -->.
// - Each step = one PR from orch/run-<n>-step-<k> into orch/run-<n>.
// - Verdict = trusted Codex review-state on the exact PR head SHA + CI check runs.

export const CODEX_BOT = Object.freeze({ login: "chatgpt-codex-connector[bot]", id: 199175422, type: "Bot" });

export const LABELS = Object.freeze({
  go: "orch:go",          // owner adds -> start / resume
  cancel: "orch:cancel",  // owner adds -> cancel
  run: "orch:run",        // set by orchestrator while a run is active
  blocked: "orch:blocked",
  done: "orch:done",
});

export const LOG_MARK = "<!-- orch:log -->";
export const PROTECTED_PATHS = [/^\.github\//, /^scripts\/orch\//];
export const MAX_STEPS = 10;
export const DEFAULT_MAX_RETRIES = 2;

export const runBranch = (n) => `orch/run-${n}`;
export const stepBranch = (n, step, attempt = 1) =>
  `orch/run-${n}-step-${step}${attempt > 1 ? `-a${attempt}` : ""}`;

// ---------------------------------------------------------------- plan

const PLAN_RE = /```json[^\n]*\n([\s\S]*?)```/;

export function parsePlan(body) {
  const m = PLAN_RE.exec(body ?? "");
  if (!m) return { ok: false, error: "본문에 ```json 계획 블록이 없습니다." };
  let raw;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, error: `계획 JSON 파싱 실패: ${e.message}` };
  }
  return validatePlan(raw);
}

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);

export function validatePlan(p) {
  const err = (e) => ({ ok: false, error: e });
  if (!p || typeof p !== "object") return err("계획이 객체가 아닙니다.");
  if (!isStr(p.goal)) return err("goal이 비어 있습니다.");
  if (!Array.isArray(p.steps) || p.steps.length === 0) return err("steps가 비어 있습니다.");
  if (p.steps.length > MAX_STEPS) return err(`steps는 최대 ${MAX_STEPS}개입니다.`);
  for (const [i, s] of p.steps.entries()) {
    const at = `steps[${i}]`;
    if (!s || typeof s !== "object") return err(`${at}가 객체가 아닙니다.`);
    if (s.id !== i + 1) return err(`${at}.id는 ${i + 1}이어야 합니다.`);
    if (!isStr(s.title)) return err(`${at}.title이 비어 있습니다.`);
    if (!isStr(s.task)) return err(`${at}.task가 비어 있습니다.`);
    if (!isStrArr(s.done_when) || s.done_when.length === 0) return err(`${at}.done_when이 비어 있습니다.`);
    if (s.stop_if !== undefined && !Array.isArray(s.stop_if)) return err(`${at}.stop_if는 배열이어야 합니다.`);
    if (s.stop_if && !isStrArr(s.stop_if)) return err(`${at}.stop_if에 빈 항목이 있습니다.`);
  }
  const maxRetries = p.max_retries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) return err("max_retries는 0~3 정수입니다.");
  if (p.model !== undefined && !(typeof p.model === "string" && /^[a-z0-9][a-z0-9.\-]{0,63}$/.test(p.model))) {
    return err("model 형식이 올바르지 않습니다.");
  }
  return {
    ok: true,
    plan: {
      goal: p.goal.trim(),
      context: isStr(p.context) ? p.context.trim() : "",
      model: p.model ?? null,
      max_retries: maxRetries,
      steps: p.steps.map((s) => ({
        id: s.id,
        title: s.title.trim(),
        task: s.task.trim(),
        done_when: s.done_when.map((x) => x.trim()),
        stop_if: (s.stop_if ?? []).map((x) => x.trim()),
      })),
    },
  };
}

// ---------------------------------------------------------------- state marker + board

const STATE_RE = /<!-- orch-state:v1 ([\s\S]*?) -->/;
const BOARD_RE = /\n*<!-- orch-board:start -->[\s\S]*?<!-- orch-board:end -->\n*/;

export function readState(body) {
  const m = STATE_RE.exec(body ?? "");
  if (!m) return null;
  try {
    const s = JSON.parse(m[1]);
    return s && typeof s === "object" && s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

export function stateMarker(state) {
  // Escape < and > so the JSON can never close the HTML comment early.
  const json = JSON.stringify(state).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!-- orch-state:v1 ${json} -->`;
}

export function stripManaged(body) {
  return (body ?? "").replace(BOARD_RE, "\n").replace(STATE_RE, "").trimEnd();
}

export function composeBody(original, plan, state, now = new Date()) {
  const board = plan ? renderBoard(plan, state, now) : "";
  return `${stripManaged(original)}\n\n<!-- orch-board:start -->\n${board}\n<!-- orch-board:end -->\n${stateMarker(state)}\n`;
}

export function kst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} KST`;
}

const STATUS_TEXT = {
  implementing: "🔄 구현 중 (Claude)",
  reviewing: "🔍 검증 중 (Codex + CI)",
  fixing: "🛠️ 수정 중 (Claude)",
  blocked: "⛔ 중단 — 판단 필요",
  awaiting_merge: "✅ 전체 완료 — 최종 머지 승인 대기",
  done: "🏁 완료",
  cancelled: "🚫 취소됨",
};

export function renderBoard(plan, state, now = new Date()) {
  const total = plan.steps.length;
  const st = state ?? {};
  const head = st.status
    ? `**상태**: ${STATUS_TEXT[st.status] ?? st.status} · Step ${st.step ?? "-"}/${total}` +
      (st.status === "reviewing" || st.status === "fixing" ? ` · 재시도 ${st.retries ?? 0}/${plan.max_retries}` : "") +
      (st.pr ? ` · PR #${st.pr}` : "") +
      (st.finalPr ? ` · 최종 PR #${st.finalPr}` : "")
    : "**상태**: 대기 — `orch:go` 라벨을 붙이면 시작합니다.";
  const passed = st.passed ?? {};
  const lines = plan.steps.map((s) => {
    if (passed[s.id]) return `- [x] Step ${s.id}. ${s.title} — 통과 (#${passed[s.id]})`;
    if (st.step === s.id && !["awaiting_merge", "done", "cancelled"].includes(st.status)) {
      return `- [ ] **Step ${s.id}. ${s.title} — ${STATUS_TEXT[st.status] ?? st.status}**`;
    }
    return `- [ ] Step ${s.id}. ${s.title}`;
  });
  const reason = st.status === "blocked" && st.reason ? `\n> 중단 사유: ${oneLine(st.reason, 300)}` : "";
  return [
    "---",
    "### 진행 상황 (orchestrator)",
    head + reason,
    "",
    ...lines,
    "",
    `_마지막 갱신: ${kst(st.updatedAt ?? now.toISOString())}_`,
  ].join("\n");
}

export const oneLine = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------- PR linkage

export const prMarker = (n, step) => `<!-- orch-run:${n}:${step} -->`;
export function parsePrMarker(body) {
  const m = /<!-- orch-run:(\d+):(\d+) -->/.exec(body ?? "");
  return m ? { issue: Number(m[1]), step: Number(m[2]) } : null;
}

// ---------------------------------------------------------------- Codex verdict

export function isTrustedCodex(user) {
  return !!user && user.login === CODEX_BOT.login && Number(user.id) === CODEX_BOT.id && user.type === CODEX_BOT.type;
}

const CODEX_RE = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/;

export function parseCodexState(body) {
  const m = CODEX_RE.exec(body ?? "");
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return null; }
  const cr = j?.code_review;
  if (!cr || typeof cr !== "object") return null;
  if (typeof cr.commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(cr.commit_sha)) return null;
  if (typeof cr.status !== "string") return null;
  if (cr.status === "completed" && typeof cr.has_unresolved_findings !== "boolean") return null;
  return { sha: cr.commit_sha, status: cr.status, unresolved: cr.has_unresolved_findings };
}

/**
 * Codex verdict for an exact head SHA.
 * The connector keeps ONE summary comment and edits it, so the latest trusted marker wins.
 * If that latest marker is for another SHA, the head has no verdict yet ("none").
 * @returns {{result: "none"|"pending"|"pass"|"fail"|"error", status?: string, url?: string}}
 */
export function codexVerdict(comments, headSha) {
  let best = null;
  for (const c of comments ?? []) {
    if (!isTrustedCodex(c.user)) continue;
    const s = parseCodexState(c.body);
    if (!s) continue;
    const at = c.updated_at ?? c.created_at ?? "";
    if (!best || at > best.at) best = { ...s, at, url: c.html_url };
  }
  if (!best || best.sha !== headSha) return { result: "none" };
  if (best.status === "completed") return { result: best.unresolved ? "fail" : "pass", status: best.status, url: best.url };
  if (best.status === "failed") return { result: "error", status: best.status, url: best.url };
  return { result: "pending", status: best.status, url: best.url };
}

// ---------------------------------------------------------------- CI verdict

const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** @returns {{result: "none"|"pending"|"success"|"failure", failed: {name: string, url: string}[]}} */
export function ciVerdict(checkRuns, excludeNames = []) {
  const runs = (checkRuns ?? []).filter((r) => !excludeNames.includes(r.name));
  if (runs.length === 0) return { result: "none", failed: [] };
  if (runs.some((r) => r.status !== "completed")) return { result: "pending", failed: [] };
  const failed = runs.filter((r) => !OK_CONCLUSIONS.has(r.conclusion)).map((r) => ({ name: r.name, url: r.html_url }));
  return { result: failed.length ? "failure" : "success", failed };
}

// ---------------------------------------------------------------- decision

/**
 * @returns {{action: "wait"|"pass"|"fail"|"block", reason?: string}}
 */
export function decide(codex, ci, { requireCi = true } = {}) {
  if (codex.result === "error") {
    return { action: "block", reason: `Codex 리뷰가 실패했습니다(status=${codex.status}). 사용량 한도를 확인한 뒤 재개해 주세요.` };
  }
  if (codex.result === "none" || codex.result === "pending") return { action: "wait", reason: "Codex 판정 대기" };
  if (ci.result === "pending") return { action: "wait", reason: "CI 대기" };
  // Codex can finish before CI has even registered its check runs: "none" means "not yet", not "no CI".
  if (ci.result === "none" && requireCi) return { action: "wait", reason: "CI 시작 대기" };
  const reasons = [];
  if (codex.result === "fail") reasons.push("Codex 미해결 지적 있음");
  if (ci.result === "failure") reasons.push(`CI 실패: ${ci.failed.map((f) => f.name).join(", ")}`);
  return reasons.length ? { action: "fail", reason: reasons.join(" / ") } : { action: "pass" };
}

export function touchesProtected(files) {
  return (files ?? []).filter((f) => PROTECTED_PATHS.some((re) => re.test(f)));
}

// ---------------------------------------------------------------- prompts

const RULES = (step) => [
  "## 작업 규칙",
  `- 이 지시의 Step ${step.id}만 구현한다. 다음 스텝을 미리 하지 않는다.`,
  "- 테스트가 있으면 실행해 통과시킨다 (`npm test`). 새 기능에는 테스트를 추가한다.",
  "- `.github/`와 `scripts/orch/`는 수정하지 않는다.",
  "- git push, 브랜치 생성, PR 생성은 하지 않는다. 커밋·푸시·PR은 오케스트레이터가 한다.",
  "- 작업이 끝나면 `.orch/SUMMARY.md`에 다음 형식으로 적는다:",
  "  - `## 변경 요약` 3~5줄",
  "  - `## 완료 기준 확인` done_when 항목별 ✅/❌와 근거(실행한 명령과 결과)",
  "- 중단 조건에 해당하거나 범위 밖 변경 없이는 완료할 수 없으면, 구현을 멈추고",
  "  `.orch/BLOCKED.md`에 이유와 사람이 판단할 내용을 적는다. 추측으로 진행하지 않는다.",
];

const stepBlock = (plan, step) => [
  `## 전체 목표\n${plan.goal}`,
  plan.context ? `## 맥락\n${plan.context}` : "",
  `## Step ${step.id}/${plan.steps.length}: ${step.title}\n${step.task}`,
  `## 완료 기준 (done_when)\n${step.done_when.map((x) => `- ${x}`).join("\n")}`,
  step.stop_if.length ? `## 중단 조건 (stop_if)\n${step.stop_if.map((x) => `- ${x}`).join("\n")}` : "",
];

export function implementPrompt(plan, stepId) {
  const step = plan.steps.find((s) => s.id === stepId);
  const done = plan.steps.filter((s) => s.id < stepId).map((s) => `- Step ${s.id}. ${s.title} (완료, 이미 코드에 반영됨)`);
  return [
    "너는 이 저장소의 개발자다. 아래 스텝 하나를 구현한다.",
    ...stepBlock(plan, step),
    done.length ? `## 이전 스텝\n${done.join("\n")}` : "",
    ...RULES(step),
  ].filter(Boolean).join("\n\n");
}

export function fixPrompt(plan, stepId, { round, maxRetries, findings, reviewBodies, ciFailed }) {
  const step = plan.steps.find((s) => s.id === stepId);
  const f = (findings ?? []).map((x, i) => `${i + 1}. \`${x.path}${x.line ? `:${x.line}` : ""}\` — ${x.body.trim()}`);
  const r = (reviewBodies ?? []).map((b) => b.trim()).filter(Boolean);
  const ci = (ciFailed ?? []).map((x) => `- ${x.name}: ${x.url}`);
  return [
    `너는 이 저장소의 개발자다. Step ${step.id} PR이 독립 검증에서 실패했다. 지적 사항을 모두 고친다. (수정 ${round}/${maxRetries}회차)`,
    ...stepBlock(plan, step),
    f.length ? `## Codex 지적 (현재 커밋 기준)\n${f.join("\n")}` : "",
    r.length ? `## Codex 리뷰 본문\n${r.join("\n\n")}` : "",
    ci.length ? `## 실패한 CI 체크\n${ci.join("\n")}\n로컬에서 같은 명령(npm test 등)을 실행해 원인을 찾아 고친다.` : "",
    !f.length && !r.length && !ci.length ? "## 지적 내용\n자동 수집된 지적이 없다. 완료 기준을 다시 점검하고 누락된 부분을 보완한다." : "",
    ...RULES(step),
  ].filter(Boolean).join("\n\n");
}

export function prBody(n, plan, stepId, summary) {
  const step = plan.steps.find((s) => s.id === stepId);
  return [
    prMarker(n, stepId),
    `Run #${n} · Step ${stepId}/${plan.steps.length}: **${step.title}**`,
    "",
    summary?.trim() || "_(Claude가 SUMMARY를 남기지 않았습니다)_",
    "",
    "---",
    `완료 기준:\n${step.done_when.map((x) => `- ${x}`).join("\n")}`,
    "",
    `_orchestrator가 생성한 스텝 PR입니다. Codex 검증과 CI를 통과하면 \`${runBranch(n)}\`에 자동 머지됩니다._`,
  ].join("\n");
}

export function finalPrBody(n, plan, passed) {
  return [
    `<!-- orch-final:${n} -->`,
    `## ${plan.goal}`,
    "",
    `Run #${n}의 모든 스텝이 Codex 검증과 CI를 통과했습니다. **머지는 사용자 승인으로만 진행합니다.**`,
    "",
    ...plan.steps.map((s) => `- Step ${s.id}. ${s.title} — #${passed[s.id]}`),
    "",
    `Run Issue: #${n} (머지 후 orchestrator가 완료 처리합니다)`,
  ].join("\n");
}
