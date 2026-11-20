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
  if (p.auto_merge !== undefined && typeof p.auto_merge !== "boolean") return err("auto_merge는 true/false입니다.");
  if (p.try !== undefined && !(typeof p.try === "string" && p.try.length <= 2000)) return err("try는 2000자 이내 문자열입니다.");
  return {
    ok: true,
    plan: {
      goal: p.goal.trim(),
      context: isStr(p.context) ? p.context.trim() : "",
      model: p.model ?? null,
      max_retries: maxRetries,
      auto_merge: p.auto_merge ?? true,
      try: isStr(p.try) ? p.try.trim() : "",
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
  finalizing: "🟢 전체 통과 — 최종 CI 확인 후 자동 머지",
  awaiting_merge: "🟡 전체 통과 — 머지 승인 대기 (완공 보고서 확인)",
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
    if (st.step === s.id && !["finalizing", "awaiting_merge", "done", "cancelled"].includes(st.status)) {
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
  if (codex.result === "fail") reasons.push(codex.source === "claude" ? "Claude 대체 검수 FAIL" : "Codex 미해결 지적 있음");
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

// ---------------------------------------------------------------- final report + risk gate

export const finalMarker = (n) => `<!-- orch-final:${n} -->`;
export function parseFinalMarker(body) {
  const m = /<!-- orch-final:(\d+) -->/.exec(body ?? "");
  return m ? Number(m[1]) : null;
}

// Changes a non-developer owner should look at before they reach main.
export const RISK_RULES = [
  { re: /(^|\/)(migrations?|prisma)\/|\.sql$|(^|\/)schema\.(prisma|sql|[mc]?[jt]s)$/i, reason: "DB 구조 변경" },
  { re: /(auth|login|logout|session|password|passwd|token|oauth|payment|billing|checkout|permission|rbac|acl|middleware)/i, reason: "로그인·결제·권한 관련 코드" },
  { re: /^\.github\//, reason: "GitHub Actions·저장소 설정 변경" },
  { re: /^scripts\/orch\//, reason: "오케스트레이터 자체 변경" },
  { re: /(^|\/)(vercel\.json|netlify\.toml|Dockerfile|docker-compose\.ya?ml|fly\.toml|wrangler\.toml|next\.config\.[mc]?[jt]s)$/i, reason: "배포·빌드 설정 변경" },
  { re: /(^|\/)\.env/i, reason: "환경변수 파일" },
  { re: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|go\.sum|Cargo\.lock)$/i, reason: "의존성 잠금 파일 변경" },
];
export const MAX_LOW_RISK_FILES = 40;

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Dependency changes between two package.json objects (null = file missing). */
export function depDiff(oldPkg, newPkg) {
  const out = [];
  for (const field of DEP_FIELDS) {
    const a = oldPkg?.[field] ?? {}, b = newPkg?.[field] ?? {};
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) out.push(`추가 ${k}@${v}`);
      else if (a[k] !== v) out.push(`변경 ${k} ${a[k]} → ${v}`);
    }
    for (const k of Object.keys(a)) if (!(k in b)) out.push(`제거 ${k}`);
  }
  return out;
}

/** @param files [{filename}] from the compare API */
export function classifyRisk(files, deps = []) {
  const byReason = new Map();
  for (const f of files ?? []) {
    for (const r of RISK_RULES) {
      if (r.re.test(f.filename)) {
        if (!byReason.has(r.reason)) byReason.set(r.reason, []);
        byReason.get(r.reason).push(f.filename);
      }
    }
  }
  const reasons = [...byReason].map(([reason, list]) => ({ reason, detail: list.slice(0, 8).join(", ") + (list.length > 8 ? ` 외 ${list.length - 8}개` : "") }));
  if (deps.length) reasons.push({ reason: "외부 패키지 추가·변경", detail: deps.slice(0, 8).join(", ") });
  if ((files ?? []).length > MAX_LOW_RISK_FILES) reasons.push({ reason: "변경 파일이 많음", detail: `${files.length}개` });
  return { level: reasons.length ? "high" : "low", reasons };
}

/** Pull the "## 변경 요약" section and any ❌ lines out of a step PR body. */
export function extractSummary(prBodyText) {
  const body = String(prBodyText ?? "").split(/\n---\n/)[0];
  const sec = /##\s*변경 요약\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  const summary = (sec ? sec[1] : "").trim().split("\n").filter(Boolean).slice(0, 6).join("\n");
  const unmet = body.split("\n").filter((l) => l.includes("❌")).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).slice(0, 5);
  return { summary, unmet };
}

/** Fallback summary when Claude left no SUMMARY.md: list the files the step changed. */
export function filesSummary(files) {
  const names = (files ?? []).map((f) => (typeof f === "string" ? f : f?.filename)).filter(Boolean);
  if (!names.length) return "";
  const shown = names.slice(0, 5).map((x) => `\`${x}\``).join(", ");
  return `- (자동 요약) 바뀐 파일: ${shown}${names.length > 5 ? ` 외 ${names.length - 5}개` : ""}`;
}

/**
 * Completion report written for a non-developer: what was built, how to try it,
 * how it was checked, what to watch out for, what was not verified.
 * @param steps [{id, title, pr, summary, unmet, reviewer, retries}]
 */
export function finalReport({ n, plan, steps, risk, autoMerge }) {
  const verdict = autoMerge
    ? "🟢 **위험 낮음 → 최종 CI 통과 시 자동 머지됩니다.** 확인할 필요는 없지만, 아래 '확인 방법'으로 써볼 수 있습니다."
    : risk.level === "high"
      ? "🟡 **확인 필요 → 아래 '주의할 점'을 보고 머지 여부를 결정해 주세요.**"
      : "🟡 **계획에서 자동 머지를 꺼 두었습니다 (`auto_merge: false`). 확인 후 머지해 주세요.**";
  const built = steps.map((s) => `**${s.id}. ${s.title}** (#${s.pr})\n${s.summary ? s.summary.split("\n").map((l) => (l.startsWith("-") ? l : `- ${l}`)).join("\n") : "- (요약 없음)"}`);
  const howTo = plan.try
    ? plan.try
    : plan.steps.flatMap((s) => s.done_when).map((x) => `- ${x}`).join("\n");
  const checks = steps.map((s) => `| ${s.id}. ${s.title} | ${s.reviewer} | ${s.retries}회 | #${s.pr} |`);
  const cautions = risk.reasons.length
    ? risk.reasons.map((r) => `- **${r.reason}**: ${r.detail}`).join("\n")
    : "- 없음 (DB·로그인·결제·권한·배포 설정·외부 패키지 변경 없음)";
  const unmet = steps.flatMap((s) => s.unmet.map((u) => `- Step ${s.id}: ${u}`));
  return [
    finalMarker(n),
    `## 완공 보고서 — ${plan.goal}`,
    "",
    verdict,
    "",
    "### 만든 것",
    built.join("\n\n"),
    "",
    "### 확인 방법",
    howTo,
    "",
    "### 검사 결과",
    "| 스텝 | 검사 | 수정 | PR |",
    "| --- | --- | --- | --- |",
    ...checks,
    "",
    "모든 스텝이 독립 검사와 CI(`npm test`)를 통과했습니다.",
    "",
    "### 주의할 점",
    cautions,
    "",
    "### 확인하지 못한 것",
    ...(unmet.length ? unmet : []),
    "- 실제 배포 환경에서는 실행해 보지 않았습니다 (CI 테스트까지만 확인).",
    "",
    `Run Issue: #${n}`,
  ].join("\n");
}

// ---------------------------------------------------------------- Claude fallback review
// Used only when Codex cannot review (status "failed", e.g. usage limit).
// Trust: the verdict comment must be written by github-actions[bot] (the claude-review workflow's
// GITHUB_TOKEN). The implementing Claude job has no token that can write issue comments.

export const ACTIONS_BOT = Object.freeze({ login: "github-actions[bot]", id: 41898282, type: "Bot" });

export function isTrustedActionsBot(user) {
  return !!user && user.login === ACTIONS_BOT.login && Number(user.id) === ACTIONS_BOT.id && user.type === ACTIONS_BOT.type;
}

const CLAUDE_REVIEW_RE = /<!-- orch-claude-review:v1 ([\s\S]*?) -->/;
const VERDICTS = new Set(["PASS", "FAIL", "ERROR"]);

export function claudeReviewMarker(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!-- orch-claude-review:v1 ${json} -->`;
}

export function parseClaudeReview(body) {
  const m = CLAUDE_REVIEW_RE.exec(body ?? "");
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return null; }
  if (!j || typeof j.commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(j.commit_sha)) return null;
  if (!VERDICTS.has(j.verdict)) return null;
  return { sha: j.commit_sha, verdict: j.verdict, findings: Array.isArray(j.findings) ? j.findings : [], summary: String(j.summary ?? "") };
}

/** @returns {{result: "none"|"pass"|"fail"|"error", findings?: object[], summary?: string, url?: string, source: "claude"}} */
export function claudeReviewVerdict(comments, headSha) {
  let best = null;
  for (const c of comments ?? []) {
    if (!isTrustedActionsBot(c.user)) continue;
    const r = parseClaudeReview(c.body);
    if (!r || r.sha !== headSha) continue;
    const at = c.updated_at ?? c.created_at ?? "";
    if (!best || at > best.at) best = { ...r, at, url: c.html_url };
  }
  if (!best) return { result: "none", source: "claude" };
  const result = best.verdict === "PASS" ? "pass" : best.verdict === "FAIL" ? "fail" : "error";
  return { result, findings: best.findings, summary: best.summary, url: best.url, status: `claude:${best.verdict}`, source: "claude" };
}

/** Validate the reviewer's .orch/REVIEW.json. Returns null if malformed (treated as ERROR). */
export function parseReviewFile(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || !["PASS", "FAIL"].includes(j.verdict)) return null;
  const findings = Array.isArray(j.findings) ? j.findings : [];
  if (j.verdict === "FAIL" && findings.length === 0) return null; // a FAIL must say what to fix
  const clean = findings.slice(0, 30).map((f) => ({
    path: String(f?.path ?? "").slice(0, 200),
    line: Number.isInteger(f?.line) ? f.line : null,
    body: String(f?.body ?? "").slice(0, 2000),
  })).filter((f) => f.body);
  if (j.verdict === "FAIL" && clean.length === 0) return null;
  return { verdict: j.verdict, summary: String(j.summary ?? "").slice(0, 3000), findings: clean };
}

export function reviewPrompt(plan, stepId, baseRef) {
  const step = plan.steps.find((s) => s.id === stepId);
  return [
    "너는 이 저장소의 독립 검수자다. 구현자와 별개로, 현재 체크아웃된 커밋이 아래 스텝을 올바르게 구현했는지 검증한다.",
    "코드는 수정하지 않는다. 판정 파일 하나만 작성한다.",
    ...stepBlock(plan, step),
    "## 검수 방법",
    `- 변경 범위: \`git diff ${baseRef}...HEAD\` (필요하면 git log/show 사용)`,
    "- `npm test`를 실행해 결과를 확인한다.",
    "- 완료 기준을 하나씩 실제 코드와 테스트로 확인한다. 테스트가 기준을 실제로 검증하는지도 본다.",
    "- 버그, 엣지 케이스 누락, 보안 문제, 스텝 범위 밖 변경을 찾는다. 스타일·취향만으로는 FAIL하지 않는다.",
    "## 결과 (반드시 작성)",
    "`.orch/REVIEW.json`에 아래 JSON만 쓴다:",
    '{"verdict":"PASS"|"FAIL","summary":"판정 근거 2~4줄","findings":[{"path":"src/x.mjs","line":12,"body":"무엇이 왜 문제이고 기대 동작은 무엇인지"}]}',
    "- FAIL이면 findings에 고쳐야 할 항목을 1개 이상 구체적으로 적는다. PASS면 findings는 빈 배열.",
  ].join("\n\n");
}

export function claudeReviewComment({ sha, verdict, summary, findings, runUrl }) {
  const head = verdict === "PASS" ? "✅ PASS" : verdict === "FAIL" ? "❌ FAIL" : "⚠️ ERROR";
  const list = (findings ?? []).map((f, i) => `${i + 1}. \`${f.path}${f.line ? `:${f.line}` : ""}\` — ${f.body}`);
  return [
    claudeReviewMarker({ commit_sha: sha, verdict, summary, findings }),
    `### Claude 대체 검수 (Opus, 독립 세션): ${head}`,
    `커밋 \`${sha.slice(0, 7)}\` · Codex 리뷰를 사용할 수 없어 대신 수행했습니다.`,
    "",
    summary || "",
    list.length ? `\n**지적 사항**\n${list.join("\n")}` : "",
    "",
    `[실행 로그](${runUrl})`,
  ].join("\n");
}
