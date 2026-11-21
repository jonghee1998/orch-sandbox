import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./core.mjs";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const codex = (body, at = "2026-11-20T10:00:00Z", user = { login: C.CODEX_BOT.login, id: C.CODEX_BOT.id, type: "Bot" }) => ({
  user, body, updated_at: at, html_url: "https://x/c",
});
const marker = (sha, status, unresolved) =>
  `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":${unresolved},"has_unresolved_findings":${unresolved},"status":"${status}"},"security_review":{"commit_sha":null}} -->\nsummary`;

const planJson = {
  goal: "단어 통계 기능",
  steps: [
    { id: 1, title: "문자 수", task: "charCount 추가", done_when: ["npm test 통과"] },
    { id: 2, title: "문장 수", task: "sentenceCount 추가", done_when: ["npm test 통과"], stop_if: ["외부 패키지 필요"] },
  ],
};
const issueBody = `설명\n\n\`\`\`json\n${JSON.stringify(planJson, null, 2)}\n\`\`\`\n`;

test("parsePlan: valid plan with defaults", () => {
  const r = C.parsePlan(issueBody);
  assert.equal(r.ok, true);
  assert.equal(r.plan.max_retries, 3);
  assert.deepEqual(r.plan.steps[0].stop_if, []);
  assert.equal(r.plan.model, null);
});

test("parsePlan: rejects missing block, bad JSON, bad ids, empty done_when, bad model", () => {
  assert.equal(C.parsePlan("no plan").ok, false);
  assert.equal(C.parsePlan("```json\n{bad\n```").ok, false);
  const bad = (patch) => C.validatePlan({ ...planJson, ...patch }).ok;
  assert.equal(bad({ steps: [{ ...planJson.steps[0], id: 2 }] }), false);
  assert.equal(bad({ steps: [{ ...planJson.steps[0], done_when: [] }] }), false);
  assert.equal(bad({ model: "opus; rm -rf /" }), false);
  assert.equal(bad({ max_retries: 9 }), false);
  assert.equal(bad({ steps: Array.from({ length: 11 }, (_, i) => ({ ...planJson.steps[0], id: i + 1 })) }), false);
});

test("state marker round-trip survives composeBody twice and escapes -->", () => {
  const plan = C.parsePlan(issueBody).plan;
  const s1 = { v: 1, status: "reviewing", step: 1, retries: 0, pr: 5, passed: {}, reason: "x --> y <z>" };
  const b1 = C.composeBody(issueBody, plan, s1);
  assert.deepEqual(C.readState(b1), s1);
  const s2 = { ...s1, status: "implementing", step: 2, passed: { 1: 5 } };
  const b2 = C.composeBody(b1, plan, s2);
  assert.deepEqual(C.readState(b2), s2);
  assert.equal(b2.match(/orch-board:start/g).length, 1, "board not duplicated");
  assert.equal(b2.match(/orch-state:v1/g).length, 1, "state not duplicated");
  assert.ok(b2.startsWith("설명"), "user text preserved");
  assert.equal(C.parsePlan(b2).ok, true, "plan still parseable");
  assert.match(b2, /- \[x\] Step 1\. 문자 수 — 통과 \(#5\)/);
});

test("readState: absent or malformed -> null", () => {
  assert.equal(C.readState("nothing"), null);
  assert.equal(C.readState("<!-- orch-state:v1 {oops -->"), null);
  assert.equal(C.readState('<!-- orch-state:v1 {"v":2} -->'), null);
});

test("codexVerdict: pass / fail / pending / error on exact head", () => {
  assert.equal(C.codexVerdict([codex(marker(SHA, "completed", false))], SHA).result, "pass");
  assert.equal(C.codexVerdict([codex(marker(SHA, "completed", true))], SHA).result, "fail");
  assert.equal(C.codexVerdict([codex(marker(SHA, "in_progress", false))], SHA).result, "pending");
  assert.equal(C.codexVerdict([codex(marker(SHA, "failed", true))], SHA).result, "error");
});

test("codexVerdict: stale SHA, forged author, prose and broken JSON give none", () => {
  assert.equal(C.codexVerdict([codex(marker(SHA2, "completed", false))], SHA).result, "none");
  const forged = codex(marker(SHA, "completed", false), undefined, { login: C.CODEX_BOT.login, id: 1, type: "Bot" });
  assert.equal(C.codexVerdict([forged], SHA).result, "none");
  const human = codex(marker(SHA, "completed", false), undefined, { login: "jonghee1998", id: 129052128, type: "User" });
  assert.equal(C.codexVerdict([human], SHA).result, "none");
  assert.equal(C.codexVerdict([codex("LGTM, no findings, status completed")], SHA).result, "none");
  assert.equal(C.codexVerdict([codex('<!-- codex-review-state:v1 {"code_review": -->')], SHA).result, "none");
});

test("codexVerdict: latest edit wins; old PASS on new head does not count", () => {
  const old = codex(marker(SHA, "completed", false), "2026-11-20T10:00:00Z");
  const newer = codex(marker(SHA2, "in_progress", false), "2026-11-20T11:00:00Z");
  assert.equal(C.codexVerdict([old, newer], SHA2).result, "pending");
  assert.equal(C.codexVerdict([old, newer], SHA).result, "none");
});

test("ciVerdict: none / pending / success / failure, excluding own jobs", () => {
  const run = (name, status, conclusion) => ({ name, status, conclusion, html_url: `u/${name}` });
  assert.equal(C.ciVerdict([]).result, "none");
  assert.equal(C.ciVerdict([run("test", "in_progress", null)]).result, "pending");
  assert.equal(C.ciVerdict([run("test", "completed", "success"), run("lint", "completed", "skipped")]).result, "success");
  const f = C.ciVerdict([run("test", "completed", "failure")]);
  assert.equal(f.result, "failure");
  assert.deepEqual(f.failed, [{ name: "test", url: "u/test" }]);
  assert.equal(C.ciVerdict([run("advance", "in_progress", null)], ["advance"]).result, "none");
});

test("decide: transitions", () => {
  const ok = { result: "success", failed: [] };
  const none = { result: "none", failed: [] };
  const bad = { result: "failure", failed: [{ name: "test" }] };
  const pend = { result: "pending", failed: [] };
  assert.equal(C.decide({ result: "none" }, ok).action, "wait");
  assert.equal(C.decide({ result: "pending" }, ok).action, "wait");
  assert.equal(C.decide({ result: "pass" }, pend).action, "wait");
  assert.equal(C.decide({ result: "pass" }, ok).action, "pass");
  assert.equal(C.decide({ result: "pass" }, none).action, "wait", "CI not registered yet");
  assert.equal(C.decide({ result: "pass" }, none, { requireCi: false }).action, "pass");
  assert.equal(C.decide({ result: "pass" }, bad).action, "fail");
  assert.equal(C.decide({ result: "fail" }, ok).action, "fail");
  assert.match(C.decide({ result: "fail" }, bad).reason, /Codex.*CI 실패: test/);
  assert.equal(C.decide({ result: "error", status: "failed" }, ok).action, "block");
});

test("PR marker and protected paths", () => {
  assert.deepEqual(C.parsePrMarker(`x\n${C.prMarker(12, 3)}\ny`), { issue: 12, step: 3 });
  assert.equal(C.parsePrMarker("<!-- orch-run:12 -->"), null);
  assert.deepEqual(C.touchesProtected(["src/a.mjs", ".github/workflows/ci.yml", "scripts/orch/main.mjs"]),
    [".github/workflows/ci.yml", "scripts/orch/main.mjs"]);
  assert.equal(C.stepBranch(7, 2), "orch/run-7-step-2");
  assert.equal(C.stepBranch(7, 2, 3), "orch/run-7-step-2-a3");
});

test("prompts include the step, criteria, findings and rules", () => {
  const plan = C.parsePlan(issueBody).plan;
  const p1 = C.implementPrompt(plan, 2);
  assert.match(p1, /Step 2\/2: 문장 수/);
  assert.match(p1, /외부 패키지 필요/);
  assert.match(p1, /Step 1\. 문자 수 \(완료/);
  assert.match(p1, /\.orch\/BLOCKED\.md/);
  const p2 = C.fixPrompt(plan, 1, {
    round: 1, maxRetries: 2,
    findings: [{ path: "src/text.mjs", line: 4, body: "null 처리 누락" }],
    reviewBodies: [], ciFailed: [{ name: "test", url: "u" }],
  });
  assert.match(p2, /수정 1\/2회차/);
  assert.match(p2, /src\/text\.mjs:4` — null 처리 누락/);
  assert.match(p2, /- test: u/);
});

test("Claude fallback review: trust, exact SHA, file validation", () => {
  const ACT = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
  const body = (sha_, v) => C.claudeReviewComment({ sha: sha_, verdict: v, summary: "x --> y", findings: [], runUrl: "u" });
  const c = (b, user = ACT, at = "2026-11-20T10:00:00Z") => ({ user, body: b, updated_at: at });
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "PASS"))], SHA).result, "pass");
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "FAIL"))], SHA).result, "fail");
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "ERROR"))], SHA).result, "error");
  assert.equal(C.claudeReviewVerdict([c(body(SHA2, "PASS"))], SHA).result, "none", "other sha");
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "PASS"), { ...ACT, id: 1 })], SHA).result, "none", "forged id");
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "PASS"), { login: "jonghee1998", id: 1, type: "User" })], SHA).result, "none");
  assert.equal(C.claudeReviewVerdict([c(body(SHA, "PASS"), ACT, "1"), c(body(SHA, "FAIL"), ACT, "2")], SHA).result, "fail", "latest wins");

  assert.deepEqual(C.parseReviewFile('{"verdict":"PASS","summary":"ok","findings":[]}'), { verdict: "PASS", summary: "ok", findings: [] });
  assert.equal(C.parseReviewFile('{"verdict":"FAIL","findings":[]}'), null, "FAIL needs findings");
  assert.equal(C.parseReviewFile('{"verdict":"MAYBE"}'), null);
  assert.equal(C.parseReviewFile("not json"), null);
  assert.equal(C.parseReviewFile('{"verdict":"FAIL","findings":[{"path":"a","line":2,"body":"b"}]}').findings[0].line, 2);
  assert.match(C.reviewPrompt(C.parsePlan(issueBody).plan, 1, "origin/orch/run-1"), /git diff origin\/orch\/run-1\.\.\.HEAD/);
});

test("risk gate: dependencies, sensitive paths, file count", () => {
  assert.deepEqual(C.depDiff({ dependencies: { a: "1" } }, { dependencies: { a: "2", b: "1" }, devDependencies: { c: "1" } }),
    ["변경 a 1 → 2", "추가 b@1", "추가 c@1"]);
  assert.deepEqual(C.depDiff({ dependencies: { a: "1" } }, {}), ["제거 a"]);
  const f = (...names) => names.map((filename) => ({ filename }));
  assert.equal(C.classifyRisk(f("src/text.mjs", "test/text.test.mjs", "README.md")).level, "low");
  for (const risky of ["db/migrations/001.sql", "prisma/schema.prisma", "src/app/api/login/route.ts", "src/payment.mjs",
    ".github/workflows/x.yml", "vercel.json", ".env.example", "package-lock.json", "scripts/orch/main.mjs"]) {
    assert.equal(C.classifyRisk(f(risky)).level, "high", risky);
  }
  assert.equal(C.classifyRisk(f("src/a.mjs"), ["추가 x@1"]).level, "high");
  assert.equal(C.classifyRisk(f(...Array.from({ length: 41 }, (_, i) => `src/f${i}.mjs`))).reasons[0].reason, "변경 파일이 많음");
});

test("pickModel: step > plan > auto, escalation after repeated failures", () => {
  const mk = (extra = {}, step = {}) => C.validatePlan({ goal: "g", ...extra, steps: [{ id: 1, title: "t", task: "문자열 유틸 추가", done_when: ["x"], ...step }] }).plan;
  assert.deepEqual(C.pickModel(mk(), 1), { model: "sonnet", why: "자동(일반 작업)" });
  assert.equal(C.pickModel(mk({}, { task: "로그인 비밀번호 검사" }), 1).model, "opus");
  assert.equal(C.pickModel(mk({}, { title: "Add DB migration" }), 1).model, "opus");
  assert.equal(C.pickModel(mk({ model: "opus" }), 1).why, "계획 지정");
  assert.equal(C.pickModel(mk({ model: "opus" }, { model: "sonnet" }), 1).model, "sonnet");
  assert.equal(C.pickModel(mk(), 1, 1).model, "sonnet");
  assert.deepEqual(C.pickModel(mk(), 1, 2), { model: "opus", why: "검수 2회 실패로 상향" });
  assert.equal(C.pickModel(mk({}, { model: "claude-opus-5-5" }), 1, 3).model, "claude-opus-5-5");
  assert.equal(C.validatePlan({ goal: "g", steps: [{ id: 1, title: "t", task: "x", done_when: ["x"], model: "a b" }] }).ok, false);
});

test("extractSummary + finalReport + plan options", () => {
  const body = "<!-- orch-run:1:1 -->\nRun\n\n## 변경 요약\n- a 추가\n- b 수정\n\n## 완료 기준 확인\n- ✅ x\n- ❌ 이메일 발송은 확인 못 함\n\n---\n완료 기준:\n- ❌ not this";
  const ex = C.extractSummary(body);
  assert.equal(ex.summary, "- a 추가\n- b 수정");
  assert.deepEqual(ex.unmet, ["❌ 이메일 발송은 확인 못 함"]);
  const plan = C.parsePlan(issueBody).plan;
  assert.equal(plan.auto_merge, true);
  assert.equal(C.validatePlan({ ...planJson, auto_merge: "yes" }).ok, false);
  const rep = C.finalReport({ n: 9, plan, autoMerge: false, risk: { level: "high", reasons: [{ reason: "DB 구조 변경", detail: "x.sql" }] },
    steps: [{ id: 1, title: "문자 수", pr: 3, ...ex, reviewer: "Codex", retries: 0 }, { id: 2, title: "문장 수", pr: 4, summary: "", unmet: [], reviewer: "Codex", retries: 1 }] });
  assert.equal(C.parseFinalMarker(rep), 9);
  assert.match(rep, /확인 필요/);
  assert.match(rep, /\*\*DB 구조 변경\*\*: x\.sql/);
  assert.match(rep, /Step 1: ❌ 이메일 발송은 확인 못 함/);
  assert.match(rep, /npm test 통과/, "done_when used as how-to when plan.try is empty");
});

test("filesSummary: fallback when SUMMARY.md is missing", () => {
  assert.equal(C.filesSummary([]), "");
  assert.equal(C.filesSummary(undefined), "");
  assert.equal(C.filesSummary([{ filename: "src/a.mjs" }, "test/a.test.mjs"]), "- (자동 요약) 바뀐 파일: `src/a.mjs`, `test/a.test.mjs`");
  assert.match(C.filesSummary(["1", "2", "3", "4", "5", "6", "7"]), /외 2개$/);
});

test("switches: parsing, time window (KST, wraps midnight, fail-closed), model resolution", () => {
  assert.deepEqual(C.readSwitches({}), { sonnet: true, opus: true, codex: true, paused: false, window: "" });
  assert.deepEqual(C.readSwitches({ ORCH_SONNET: "OFF", ORCH_OPUS: "false", ORCH_CODEX: "0", ORCH_PAUSED: "on" }),
    { sonnet: false, opus: false, codex: false, paused: true, window: "" });
  assert.equal(C.readSwitches({ ORCH_CODEX: "maybe" }).codex, true, "unknown value keeps default");
  const at = (hhmm) => Date.parse(`2026-11-20T${hhmm}:00+09:00`);
  assert.equal(C.windowOpen("", at("03:00")), true);
  assert.equal(C.windowOpen("09:00-18:00", at("09:00")), true);
  assert.equal(C.windowOpen("09:00-18:00", at("18:00")), false);
  assert.equal(C.windowOpen("22:00-06:00", at("23:30")), true);
  assert.equal(C.windowOpen("22:00-06:00", at("05:59")), true);
  assert.equal(C.windowOpen("22:00-06:00", at("12:00")), false);
  assert.equal(C.windowOpen("08:00-24:00", at("23:59")), true);
  assert.equal(C.windowOpen("bogus", at("12:00")), false, "invalid window fails closed");
  assert.match(C.gateReason({ paused: true, window: "" }), /일시정지/);
  assert.match(C.gateReason({ paused: false, window: "09:00-10:00" }, at("12:00")), /시간대/);
  assert.equal(C.gateReason({ paused: false, window: "" }), null);
  const on = { sonnet: true, opus: true };
  assert.equal(C.resolveModel({ model: "opus", why: "a" }, on).model, "opus");
  assert.equal(C.resolveModel({ model: "opus", why: "a" }, { sonnet: true, opus: false }).model, "sonnet");
  assert.equal(C.resolveModel({ model: "sonnet", why: "a" }, { sonnet: false, opus: true }).model, "opus");
  assert.ok(C.resolveModel({ model: "claude-opus-5-5", why: "a" }, { sonnet: false, opus: false }).hold);
  assert.equal(C.reviewRoute({ codex: true, opus: true }, false), "codex");
  assert.equal(C.reviewRoute({ codex: true, opus: true }, true), "claude");
  assert.equal(C.reviewRoute({ codex: false, opus: true }, false), "claude");
  assert.equal(C.reviewRoute({ codex: false, opus: false }, false), null);
});

test("codexVerdict: plain-text usage-limit notice counts as Codex unavailable", () => {
  const H1 = "1".repeat(40), H0 = "0".repeat(40);
  const bot = { login: C.CODEX_BOT.login, id: C.CODEX_BOT.id, type: "Bot" };
  const limit = (at) => ({ user: bot, body: "You have reached your Codex usage limits for code reviews. You can see your limits in the dashboard.", created_at: at, updated_at: at, html_url: "u" });
  const state = (sha, at, status = "completed") => ({ user: bot, created_at: at, updated_at: at, html_url: "s",
    body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status, commit_sha: sha, has_unresolved_findings: false } })} -->` });
  assert.deepEqual(C.codexVerdict([limit("2026-11-21T00:00:00Z")], H1), { result: "error", status: "usage_limit", url: "u" });
  assert.equal(C.codexVerdict([limit("2026-11-21T00:00:00Z"), state(H1, "2026-11-21T01:00:00Z")], H1).result, "pass", "review after the notice wins");
  assert.equal(C.codexVerdict([state(H0, "2026-11-20T23:00:00Z"), limit("2026-11-21T00:00:00Z")], H1).result, "error");
  const fake = { ...limit("2026-11-21T00:00:00Z"), user: { login: bot.login, id: 1 } };
  assert.equal(C.codexVerdict([fake], H1).result, "none", "untrusted author ignored");
});

test("readState: a plan that mentions the marker in prose does not hide the real state (run #239)", () => {
  const prose = "context: 상태 마커는 <!-- orch-state:v1 --> 마커(passed 객체)이다.\n\n```json\n{}\n```";
  const real = C.stateMarker({ v: 1, status: "implementing", step: 1 });
  assert.equal(C.readState(`${prose}\n${real}`).status, "implementing");
  assert.equal(C.readState(`${C.stateMarker({ v: 1, status: "old" })}\n${real}`).status, "implementing", "last valid marker wins");
  assert.equal(C.readState(prose), null);
  assert.match(C.stripManaged(`${prose}\n${real}`), /<!-- orch-state:v1 --> 마커/, "prose kept, real marker removed");
  assert.doesNotMatch(C.stripManaged(`${prose}\n${real}`), /"status"/);
});

test("resolvePatchNotes: keeps both sides newest-first; refuses same version or non-entry conflicts", () => {
  const e = (v) => `  { version: "${v}", date: "2026-11-21", title: "t${v}", items: ["x"] },`;
  const file = (mid) => ["export const PATCH_NOTES = [", ...mid, e("1.12.0"), "];"].join("\n");
  const conflicted = file(["<<<<<<< HEAD", e("1.13.0"), "=======", e("1.12.1"), ">>>>>>> origin/main"]);
  assert.equal(C.resolvePatchNotes(conflicted), file([e("1.13.0"), e("1.12.1")]));
  const reversed = file(["<<<<<<< HEAD", e("1.12.1"), "=======", e("1.13.0"), ">>>>>>> origin/main"]);
  assert.equal(C.resolvePatchNotes(reversed), file([e("1.13.0"), e("1.12.1")]), "sorted by version, not by side");
  assert.equal(C.resolvePatchNotes(file(["<<<<<<< HEAD", e("1.13.0"), "=======", e("1.13.0").replace("t1", "u1"), ">>>>>>> m"])), null);
  assert.equal(C.resolvePatchNotes(file(["<<<<<<< HEAD", "const x = 1;", "=======", e("1.13.0"), ">>>>>>> m"])), null);
  assert.equal(C.resolvePatchNotes(file(["<<<<<<< HEAD", e("1.13.0")])), null, "unterminated");
  assert.equal(C.finalSyncResult([{ user: { id: 41898282, type: "Bot" }, body: C.finalSyncMarker({ head: "h", ok: false, files: [] }) }], "h").ok, false);
  assert.equal(C.finalSyncResult([{ user: { id: 41898282, type: "Bot" }, body: C.finalSyncMarker({ head: "h", ok: false, files: [] }) }], "other"), null);
});

test("resolvePatchNotes: same entry on both sides, one with the PR number filled in → keep that one (run #254)", () => {
  const e = (v, pr) => `  { version: "${v}", date: "2026-11-21",${pr ? ` pr: ${pr},` : ""} title: "t${v}", items: ["x"] },`;
  const file = (mid) => ["export const PATCH_NOTES = [", ...mid, e("1.13.0", 249), "];"].join("\n");
  const conflicted = file(["<<<<<<< HEAD", e("1.15.0"), e("1.13.1"), "=======", e("1.14.0", 253), e("1.13.1", 255), ">>>>>>> origin/main"]);
  assert.equal(C.resolvePatchNotes(conflicted), file([e("1.15.0"), e("1.14.0", 253), e("1.13.1", 255)]));
  const reversed = file(["<<<<<<< HEAD", e("1.13.1", 255), "=======", e("1.13.1"), ">>>>>>> m"]);
  assert.equal(C.resolvePatchNotes(reversed), file([e("1.13.1", 255)]));
});
