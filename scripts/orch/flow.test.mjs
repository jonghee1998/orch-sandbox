// End-to-end state machine test against an in-memory fake GitHub API (no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "./core.mjs";

const OWNER = { login: "owner", id: 1, type: "User" };
const CODEX = { login: C.CODEX_BOT.login, id: C.CODEX_BOT.id, type: "Bot" };
const sha = (c) => c.repeat(40);

function fakeGitHub() {
  const db = { seq: 0, issues: {}, comments: {}, labels: new Set(), refs: { main: sha("0") }, dispatches: [], checks: {}, notifications: [], merges: [], reviews: [], compareFiles: ["src/text.mjs", "test/text.test.mjs"], pkg: {} };
  let clock = Date.parse("2026-11-20T00:00:00Z");
  const ts = () => new Date((clock += 1000)).toISOString();
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });

  db.newIssue = (body, user = OWNER, extra = {}) => {
    const n = ++db.seq;
    db.issues[n] = { number: n, body, user, state: "open", labels: [], html_url: `https://gh/i/${n}`, ...extra };
    db.comments[n] = [];
    return db.issues[n];
  };
  db.addComment = (n, body, user = OWNER) => {
    const c = { id: ++db.seq * 1000, body, user, created_at: ts(), updated_at: ts(), html_url: `https://gh/c/${n}` };
    db.comments[n].push(c);
    return c;
  };

  async function handler(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.hostname === "ntfy.sh") { db.notifications.push(body); return json(200, {}); }
    const p = u.pathname.replace(/^\/repos\/o\/r/, "");
    const page = Number(u.searchParams.get("page") ?? 1);
    const paged = (arr) => json(200, page > 1 ? [] : arr);
    let m;

    if (p === "/graphql") return json(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (p === "/labels" && method === "POST") {
      if (db.labels.has(body.name)) return json(422, { message: "exists" });
      db.labels.add(body.name); return json(201, {});
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(p))) {
      const name = decodeURIComponent(m[1]);
      return db.refs[name] ? json(200, { object: { sha: db.refs[name] } }) : json(404, {});
    }
    if (p === "/git/refs" && method === "POST") {
      const name = body.ref.replace("refs/heads/", "");
      if (db.refs[name]) return json(422, {});
      db.refs[name] = body.sha; return json(201, {});
    }
    if (p === "/issues" && method === "GET") {
      const label = u.searchParams.get("labels");
      return paged(Object.values(db.issues).filter((i) => i.state === "open" && i.labels.some((l) => l.name === label)));
    }
    if ((m = /^\/issues\/(\d+)$/.exec(p))) {
      const it = db.issues[m[1]];
      if (!it) return json(404, {});
      if (method === "PATCH") Object.assign(it, body);
      return json(200, it);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      if (method === "POST") return json(201, db.addComment(m[1], body.body));
      return paged(db.comments[m[1]] ?? []);
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(p))) {
      const it = db.issues[m[1]];
      for (const l of body.labels) if (!it.labels.some((x) => x.name === l)) it.labels.push({ name: l });
      return json(200, it.labels);
    }
    if ((m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(p))) {
      const it = db.issues[m[1]];
      const name = decodeURIComponent(m[2]);
      if (!it.labels.some((l) => l.name === name)) return json(404, {});
      it.labels = it.labels.filter((l) => l.name !== name); return json(200, []);
    }
    if (p === "/pulls" && method === "POST") {
      const pr = db.newIssue(body.body, OWNER, {
        pull_request: {}, title: body.title, head: { ref: body.head, sha: db.refs[body.head] ?? sha("1") }, base: { ref: body.base },
      });
      return json(201, pr);
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(p))) {
      const pr = db.issues[m[1]];
      if (!pr?.pull_request) return json(404, {});
      if (method === "PATCH") Object.assign(pr, body);
      return json(200, pr);
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(p))) {
      const pr = db.issues[m[1]];
      if (body.sha !== pr.head.sha) return json(409, { message: "Head branch was modified" });
      pr.state = "closed"; pr.merged_at = ts(); db.merges.push({ pr: pr.number, ...body });
      return json(200, { merged: true });
    }
    if (/^\/pulls\/\d+\/(comments|reviews)$/.test(p)) return paged([]);
    if (p.startsWith("/compare/")) {
      const head = decodeURIComponent(p.split("...")[1] ?? "");
      return json(200, { ahead_by: db.refs[head] ? 1 : 0, files: db.compareFiles.map((filename) => ({ filename })),
        commits: db.refs[head] ? [{ commit: { message: "Run #1 step 1: implement\n\n## 변경 요약\n- 복구된 요약" } }] : [] });
    }
    if (p === "/pulls" && method === "GET") {
      const head = (u.searchParams.get("head") ?? "").split(":")[1];
      return json(200, Object.values(db.issues).filter((i) => i.pull_request && i.state === "open" && i.head.ref === head));
    }
    if (p === "/contents/package.json") {
      const pkg = db.pkg[u.searchParams.get("ref")];
      return pkg ? json(200, { content: Buffer.from(JSON.stringify(pkg)).toString("base64") }) : json(404, {});
    }
    if ((m = /^\/commits\/([a-f0-9]+)\/check-runs$/.exec(p))) return json(200, { check_runs: page > 1 ? [] : db.checks[m[1]] ?? [] });
    if (p === "/actions/workflows/claude-work.yml/dispatches") { db.dispatches.push(body.inputs); return json(204); }
    if (p === "/actions/workflows/claude-review.yml/dispatches") { db.reviews.push(body.inputs); return json(204); }
    if (p === "/actions/workflows/claude-work.yml/runs") return json(200, { workflow_runs: [] });
    throw new Error(`fake GitHub: unhandled ${method} ${p}`);
  }
  return { db, handler };
}

// ---------------------------------------------------------------- harness

const { db, handler } = fakeGitHub();
globalThis.fetch = handler;
Object.assign(process.env, {
  GITHUB_REPOSITORY: "o/r", BOT_PAT: "pat", READ_TOKEN: "ro", NTFY_TOPIC: "t", GITHUB_RUN_ID: "9", GITHUB_SERVER_URL: "https://gh",
});
delete process.env.GITHUB_OUTPUT;
process.env.GITHUB_REPOSITORY = "o/r";
const { commands } = await import("./main.mjs");
// The fake repo owner is "o"; make the fake owner login match.
OWNER.login = "o";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
async function fire(name, payload) {
  const file = path.join(tmp, `${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  process.env.GITHUB_EVENT_NAME = name;
  process.env.GITHUB_EVENT_PATH = file;
  await commands.event();
}
async function publish(issue, mode, step, extra = {}) {
  Object.assign(process.env, {
    ISSUE: String(issue), MODE: mode, STEP: String(step), WORK_RESULT: "success", SKIP: "false",
    CHANGED: "true", BLOCKED: "", SUMMARY: "## 변경 요약\n- 테스트", BRANCH: C.stepBranch(issue, step), ...extra,
  });
  await commands.publish();
}
const state = (n) => C.readState(db.issues[n].body);
const labels = (n) => db.issues[n].labels.map((l) => l.name).sort();
const codexSays = (pr, headSha, status, unresolved) => {
  const body = `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","has_unresolved_findings":${unresolved},"status":"${status}"}} -->`;
  const c = db.addComment(pr, body, CODEX);
  return fire("issue_comment", { action: "created", issue: { number: pr, pull_request: {} }, comment: c });
};
const ciDone = (prNum) => fire("workflow_run", {
  workflow: { name: "ci" }, workflow_run: { name: "ci", conclusion: "success", pull_requests: [{ number: prNum }] },
});
const ciPass = (s) => { db.checks[s] = [{ name: "test", status: "completed", conclusion: "success", html_url: "u" }]; };
const ciFail = (s) => { db.checks[s] = [{ name: "test", status: "completed", conclusion: "failure", html_url: "u" }]; };

const plan = (steps, extra = {}) => `계획\n\n\`\`\`json\n${JSON.stringify({
  goal: "테스트 목표",
  steps: Array.from({ length: steps }, (_, i) => ({ id: i + 1, title: `스텝${i + 1}`, task: "do", done_when: ["npm test 통과"] })),
  ...extra,
})}\n\`\`\``;

// ---------------------------------------------------------------- scenarios

test("happy path with one fix round: start -> PR -> FAIL -> fix -> PASS -> next step -> final PR -> done", async () => {
  const issue = db.newIssue(plan(2));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  assert.equal(state(n).status, "implementing");
  assert.equal(db.refs[C.runBranch(n)], sha("0"), "run branch from main");
  assert.deepEqual(db.dispatches.at(-1), { issue: String(n), mode: "implement", step: "1" });
  assert.deepEqual(labels(n), ["orch:run"]);

  db.refs[C.stepBranch(n, 1)] = sha("a");
  await publish(n, "implement", 1);
  const pr1 = state(n).pr;
  assert.equal(state(n).status, "reviewing");
  assert.equal(db.issues[pr1].base.ref, C.runBranch(n));
  assert.deepEqual(C.parsePrMarker(db.issues[pr1].body), { issue: n, step: 1 });

  // CI passes but Codex finds problems -> fix
  ciPass(sha("a"));
  await codexSays(pr1, sha("a"), "in_progress", false);
  assert.equal(state(n).status, "reviewing", "in_progress -> wait");
  await codexSays(pr1, sha("a"), "completed", true);
  assert.equal(state(n).status, "fixing");
  assert.equal(state(n).retries, 1);
  assert.deepEqual(db.dispatches.at(-1), { issue: String(n), mode: "fix", step: "1" });

  // Claude pushes a fix -> re-review requested
  db.issues[pr1].head.sha = sha("b");
  await publish(n, "fix", 1);
  assert.equal(state(n).status, "reviewing");
  assert.ok(db.comments[pr1].some((c) => c.body === "@codex review"));

  // A stale PASS for the old head must not pass the new head
  await codexSays(pr1, sha("a"), "completed", false);
  assert.equal(state(n).status, "reviewing");

  ciPass(sha("b"));
  await codexSays(pr1, sha("b"), "completed", false);
  assert.equal(db.issues[pr1].merged_at !== undefined, true, "step PR merged");
  assert.equal(db.merges.at(-1).sha, sha("b"), "merge pinned to judged head");
  assert.equal(state(n).status, "implementing");
  assert.equal(state(n).step, 2);
  assert.equal(state(n).retries, 0);
  assert.deepEqual(state(n).passed, { 1: pr1 });

  db.refs[C.stepBranch(n, 2)] = sha("c");
  await publish(n, "implement", 2);
  const pr2 = state(n).pr;
  ciPass(sha("c"));
  await codexSays(pr2, sha("c"), "completed", false);
  const st = state(n);
  assert.equal(st.status, "finalizing", "low risk -> auto merge path");
  const final = db.issues[st.finalPr];
  assert.equal(final.base.ref, "main");
  assert.equal(final.head.ref, C.runBranch(n));
  assert.match(final.body, /완공 보고서/);
  assert.match(final.body, /위험 낮음/);
  assert.match(final.body, /\| 1\. 스텝1 \| sonnet \| - \| Codex \| 1회 \|/, "step 1 needed one fix");
  assert.match(db.issues[n].body, /- \[x\] Step 2\. 스텝2 — 통과/);

  // CI still running on the final PR -> wait
  db.checks[final.head.sha] = [{ name: "test", status: "in_progress", conclusion: null, html_url: "u" }];
  await ciDone(final.number);
  assert.equal(state(n).status, "finalizing");
  ciPass(final.head.sha);
  await ciDone(final.number);
  assert.ok(final.merged_at, "final PR auto-merged");
  assert.equal(db.merges.at(-1).merge_method, "merge");
  assert.equal(state(n).status, "done");
  assert.equal(db.issues[n].state, "closed");
  assert.deepEqual(labels(n), ["orch:done"]);
  assert.match(db.notifications.at(-1).title, /자동 머지/);
});

test("high risk (new dependency + auth file) -> awaiting owner with report; owner merge -> done", async () => {
  db.compareFiles = ["src/auth/login.mjs", "package.json", "package-lock.json"];
  db.pkg = { main: { dependencies: {} }, [C.runBranch(db.seq + 1)]: { dependencies: { bcrypt: "^6.0.0" } } };
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("4");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("4"));
  await codexSays(pr, sha("4"), "completed", false);
  const st = state(n);
  assert.equal(st.status, "awaiting_merge");
  const final = db.issues[st.finalPr];
  assert.match(final.body, /확인 필요/);
  assert.match(final.body, /로그인·결제·권한 관련 코드\*\*: src\/auth\/login\.mjs/);
  assert.match(final.body, /외부 패키지 추가·변경\*\*: 추가 bcrypt@\^6\.0\.0/);
  assert.match(db.notifications.at(-1).title, /승인 필요/);
  assert.equal(final.merged_at, undefined, "never auto-merged");

  final.merged_at = "2026-11-21T01:00:00Z"; final.state = "closed";
  await fire("schedule", {});
  assert.equal(state(n).status, "done");
  db.compareFiles = ["src/text.mjs", "test/text.test.mjs"];
  db.pkg = {};
});

test("auto_merge: false keeps a low-risk run for the owner", async () => {
  const issue = db.newIssue(plan(1, { auto_merge: false }));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("3");
  await publish(n, "implement", 1);
  ciPass(sha("3"));
  await codexSays(state(n).pr, sha("3"), "completed", false);
  assert.equal(state(n).status, "awaiting_merge");
  assert.match(db.issues[state(n).finalPr].body, /auto_merge: false/);
});

test("final PR CI failure -> blocked as final; resume switches to manual merge", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("2");
  await publish(n, "implement", 1);
  ciPass(sha("2"));
  await codexSays(state(n).pr, sha("2"), "completed", false);
  const final = db.issues[state(n).finalPr];
  db.checks[final.head.sha] = [{ name: "test", status: "completed", conclusion: "failure", html_url: "u" }];
  await ciDone(final.number);
  assert.equal(state(n).status, "blocked");
  assert.equal(state(n).blockKind, "final");
  assert.equal(final.merged_at, undefined);
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: db.issues[n] });
  assert.equal(state(n).status, "awaiting_merge");
});

test("retry limit -> blocked with notification; resume restarts the step on a new attempt", async () => {
  const issue = db.newIssue(plan(1, { max_retries: 1 }));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("d");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciFail(sha("d"));
  await codexSays(pr, sha("d"), "completed", false);
  assert.equal(state(n).status, "fixing", "CI failure alone fails the step");
  db.issues[pr].head.sha = sha("e");
  await publish(n, "fix", 1);
  ciFail(sha("e"));
  await codexSays(pr, sha("e"), "completed", false);
  assert.equal(state(n).status, "blocked");
  assert.match(state(n).reason, /2회 연속 실패.*CI 실패: test/);
  assert.ok(labels(n).includes("orch:blocked"));
  assert.match(db.notifications.at(-1).title, /중단/);

  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: db.issues[n] });
  assert.equal(state(n).status, "implementing");
  assert.equal(state(n).attempt, 2);
  assert.equal(db.issues[pr].state, "closed", "old step PR closed on restart");
  assert.ok(!labels(n).includes("orch:blocked"));
});

const ACTIONS = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const claudeReviewSays = (pr, headSha, verdict, findings = []) => {
  db.addComment(pr, C.claudeReviewComment({ sha: headSha, verdict, summary: "s", findings, runUrl: "u" }), ACTIONS);
  return fire("workflow_run", { workflow: { name: "claude-review" }, workflow_run: { name: `claude-review #0 pr ${pr}`, display_title: `claude-review #0 pr ${pr}`, conclusion: "success" } });
};

test("Codex failed (usage limit) -> Claude fallback review once -> FAIL -> fix -> fallback PASS -> done", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("f");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("f"));
  await codexSays(pr, sha("f"), "failed", true);
  assert.equal(state(n).status, "reviewing", "not blocked: fallback instead");
  assert.deepEqual(db.reviews.at(-1), { issue: String(n), pr: String(pr), sha: sha("f") });
  const reviews = db.reviews.length;
  await codexSays(pr, sha("f"), "failed", true);          // repeated event -> no duplicate dispatch
  assert.equal(db.reviews.length, reviews);

  // A PASS-looking marker from the owner account (e.g. written by the implementing job) is not trusted
  db.addComment(pr, C.claudeReviewComment({ sha: sha("f"), verdict: "PASS", summary: "", findings: [], runUrl: "u" }), OWNER);
  await fire("workflow_run", { workflow: { name: "claude-review" }, workflow_run: { name: `claude-review #${n} pr ${pr}`, display_title: `claude-review #${n} pr ${pr}`, conclusion: "success" } });
  assert.equal(state(n).status, "reviewing");

  await claudeReviewSays(pr, sha("f"), "FAIL", [{ path: "src/text.mjs", line: 3, body: "null 처리 누락" }]);
  assert.equal(state(n).status, "fixing");
  assert.match(db.comments[n].at(-1).body, /Claude 대체 검수 FAIL/);

  db.issues[pr].head.sha = sha("7");
  await publish(n, "fix", 1);
  ciPass(sha("7"));
  await codexSays(pr, sha("7"), "failed", true);
  assert.equal(db.reviews.at(-1).sha, sha("7"), "new head gets its own fallback review");
  await claudeReviewSays(pr, sha("7"), "PASS");
  assert.equal(state(n).status, "finalizing");
  assert.match(db.issues[state(n).finalPr].body, /Claude Opus \(대체\) \| 1회/);
});

test("fallback review ERROR -> blocked as review; resume re-requests Codex", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("6");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("6"));
  await codexSays(pr, sha("6"), "failed", true);
  await claudeReviewSays(pr, sha("6"), "ERROR");
  assert.equal(state(n).status, "blocked");
  assert.equal(state(n).blockKind, "review");
  const before = db.comments[pr].filter((c) => c.body === "@codex review").length;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: db.issues[n] });
  assert.equal(state(n).status, "reviewing");
  assert.equal(state(n).claudeReviewFor, null);
  assert.equal(db.comments[pr].filter((c) => c.body === "@codex review").length, before + 1);
});

test("fallback review workflow fails without a verdict -> blocked (no silent wait)", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("5");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("5"));
  await codexSays(pr, sha("5"), "failed", true);
  assert.equal(state(n).claudeReviewFor, sha("5"));
  await fire("workflow_run", { workflow: { name: "claude-review" }, workflow_run: { name: `claude-review #${n} pr ${pr}`, display_title: `claude-review #${n} pr ${pr}`, conclusion: "failure" } });
  assert.equal(state(n).status, "blocked");
  assert.match(state(n).reason, /판정 없이 실패/);
});

test("lost publish: pushed branch is recovered into a PR; nothing pushed -> blocked", async () => {
  const lost = (n) => fire("workflow_run", { workflow: { name: "claude-work" }, workflow_run: {
    name: `claude-work #${n} implement step 1`, display_title: `claude-work #${n} implement step 1`,
    conclusion: "cancelled", created_at: new Date().toISOString(), html_url: "u" } });
  const i1 = db.newIssue(plan(1));
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: i1 });
  db.refs[C.stepBranch(i1.number, 1)] = sha("8");
  await lost(i1.number);
  assert.equal(state(i1.number).status, "reviewing");
  const pr = db.issues[state(i1.number).pr];
  assert.equal(pr.head.ref, C.stepBranch(i1.number, 1));
  assert.match(db.comments[i1.number].at(-1).body, /복구/);
  assert.match(pr.body, /복구된 요약/, "summary rebuilt from the commit message");
  await lost(i1.number);                       // repeated event: state is no longer implementing -> no duplicate PR
  assert.equal(Object.values(db.issues).filter((x) => x.pull_request && x.head?.ref === pr.head.ref).length, 1);

  const i2 = db.newIssue(plan(1));
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: i2 });
  await lost(i2.number);
  assert.equal(state(i2.number).status, "blocked");
});

test("step PR already merged by a concurrent run is not reported as a failure", async () => {
  const issue = db.newIssue(plan(2));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("1");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("1"));
  await codexSays(pr, sha("1"), "completed", false);
  assert.equal(state(n).step, 2);
  // a late duplicate event for the same (now merged) PR is ignored
  await codexSays(pr, sha("1"), "completed", false);
  assert.equal(state(n).status, "implementing");
  assert.equal(state(n).step, 2);
});

test("Claude BLOCKED / no change / work failure -> blocked; untrusted triggers ignored", async () => {
  const mk = async () => {
    const issue = db.newIssue(plan(1));
    await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
    return issue.number;
  };
  let n = await mk();
  await publish(n, "implement", 1, { BLOCKED: "외부 API 키 필요", CHANGED: "false" });
  assert.match(state(n).reason, /Claude 중단 보고: 외부 API 키 필요/);
  n = await mk();
  await publish(n, "implement", 1, { CHANGED: "false" });
  assert.match(state(n).reason, /변경 사항 없이/);
  n = await mk();
  await publish(n, "implement", 1, { WORK_RESULT: "failure" });
  assert.match(state(n).reason, /실행이 실패/);

  // Label added by someone else, or plan issue written by someone else -> ignored
  const dispatches = db.dispatches.length;
  const i1 = db.newIssue(plan(1));
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "mallory" }, issue: i1 });
  const i2 = db.newIssue(plan(1), { login: "mallory", id: 9, type: "User" });
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: i2 });
  assert.equal(state(i1.number), null);
  assert.equal(state(i2.number), null);
  assert.equal(db.dispatches.length, dispatches);

  // Invalid plan -> explanatory comment, no dispatch
  const i3 = db.newIssue("```json\n{\"goal\":\"x\",\"steps\":[]}\n```");
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue: i3 });
  assert.match(db.comments[i3.number].at(-1).body, /계획을 읽을 수 없어/);
  assert.equal(db.dispatches.length, dispatches);
});

test("stale publish after cancel is a no-op; forged Codex marker is ignored", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("9");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("9"));
  const forged = db.addComment(pr, `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha("9")}","has_unresolved_findings":false,"status":"completed"}} -->`, { login: CODEX.login, id: 5, type: "Bot" });
  await fire("issue_comment", { action: "created", issue: { number: pr, pull_request: {} }, comment: forged });
  assert.equal(state(n).status, "reviewing", "forged id does not pass");

  await fire("issues", { action: "labeled", label: { name: "orch:cancel" }, sender: { login: "o" }, issue: db.issues[n] });
  assert.equal(state(n).status, "cancelled");
  assert.equal(db.issues[pr].state, "closed");
  const prs = Object.keys(db.issues).length;
  await publish(n, "implement", 1);
  assert.equal(Object.keys(db.issues).length, prs, "no PR created after cancel");
});

// ---------------------------------------------------------------- ON/OFF switches

const withSwitches = async (vars, fn) => {
  const keys = ["ORCH_SONNET", "ORCH_OPUS", "ORCH_CODEX", "ORCH_PAUSED", "ORCH_WINDOW"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test("switches: Sonnet+Opus OFF holds new work without dispatch, watchdog resumes when back ON", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  const before = db.dispatches.length;
  await withSwitches({ ORCH_SONNET: "off", ORCH_OPUS: "off" }, async () => {
    await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
    assert.equal(state(n).status, "implementing");
    assert.equal(db.dispatches.length, before, "nothing dispatched while OFF");
    assert.match(state(n).held.reason, /모두 OFF/);
    assert.match(db.issues[n].body, /대기 중/);
    await fire("schedule", {});
    assert.equal(db.dispatches.length, before, "still held on watchdog");
  });
  await withSwitches({ ORCH_SONNET: "off" }, async () => {
    await fire("schedule", {});
    assert.equal(db.dispatches.length, before + 1, "resumed with Opus");
    assert.equal(state(n).held, null);
  });
  await withSwitches({ ORCH_PAUSED: "on" }, async () => {
    db.refs[C.stepBranch(n, 1)] = sha("d");
    await publish(n, "implement", 1);                 // running work drains even while paused
    assert.equal(state(n).status, "reviewing");
  });
});

test("switches: Codex OFF routes review to Opus and ignores Codex verdicts; Codex+Opus OFF holds review", async () => {
  const issue = db.newIssue(plan(1));
  const n = issue.number;
  await fire("issues", { action: "labeled", label: { name: "orch:go" }, sender: { login: "o" }, issue });
  db.refs[C.stepBranch(n, 1)] = sha("e");
  await publish(n, "implement", 1);
  const pr = state(n).pr;
  ciPass(sha("e"));

  await withSwitches({ ORCH_CODEX: "off", ORCH_OPUS: "off" }, async () => {
    const reviews = db.reviews.length;
    await ciDone(pr);
    assert.equal(db.reviews.length, reviews, "no reviewer available -> no dispatch");
    assert.match(state(n).held.reason, /검수할 수 있는 AI가 없음/);
    await fire("schedule", {});
    assert.equal(state(n).status, "reviewing", "held review never times out into blocked");
  });

  await withSwitches({ ORCH_CODEX: "off" }, async () => {
    await codexSays(pr, sha("e"), "completed", true);   // Codex FAIL while OFF -> ignored
    assert.notEqual(state(n).status, "fixing");
    assert.equal(db.reviews.at(-1).pr, String(pr), "Opus fallback review dispatched");
    assert.equal(state(n).held, null);
    assert.match(db.comments[n].at(-1).body, /Codex가 OFF라 Claude\(Opus\) 대체 검수/);
  });
});
