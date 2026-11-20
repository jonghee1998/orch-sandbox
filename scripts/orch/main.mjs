// Orchestrator entry point.
//   node scripts/orch/main.mjs event    -> orchestrator.yml (state transitions)
//   node scripts/orch/main.mjs prepare  -> claude-work.yml / work job, before Claude
//   node scripts/orch/main.mjs commit   -> claude-work.yml / work job, after Claude
//   node scripts/orch/main.mjs publish  -> claude-work.yml / publish job (open PR / request review / block)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const OWNER = REPO?.split("/")[0];
const RUN_URL = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${REPO}/actions/runs/${env.GITHUB_RUN_ID}`;

// Write client = owner PAT (its events trigger CI and Codex). Read/dispatch client = workflow GITHUB_TOKEN.
const gh = () => client(env.BOT_PAT, REPO);
const ro = () => client(env.READ_TOKEN || env.BOT_PAT, REPO);

const NUDGE_AFTER_MIN = 15;          // no Codex verdict for the head after this -> "@codex review" once
const WORK_IDLE_MIN = 75;            // implementing/fixing without result
const REVIEW_IDLE_MIN = 120;         // reviewing without verdict even after nudge
const SELF_CHECKS = ["advance", "work", "publish"];

const now = () => new Date().toISOString();
const minutesSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity);
const log = (...a) => console.log("[orch]", ...a);

function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return log(`output ${key}=${v.slice(0, 200)}`);
  const delim = `ORCH_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// ---------------------------------------------------------------- notifications

async function notify(title, message, url) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: C.oneLine(message, 900), click: url }),
    });
  } catch (e) {
    log("notify failed", e.message);
  }
}

// ---------------------------------------------------------------- run I/O

async function loadRun(n, c = gh()) {
  const issue = await c.get(`/issues/${n}`, { allow404: true });
  if (!issue || issue.pull_request) return null;
  const parsed = C.parsePlan(issue.body);
  return {
    n: Number(n),
    issue,
    plan: parsed.ok ? parsed.plan : null,
    planError: parsed.ok ? null : parsed.error,
    state: C.readState(issue.body),
  };
}

async function save(run, patch, logLine) {
  const state = { ...(run.state ?? { v: 1 }), ...patch, v: 1, updatedAt: now() };
  const body = C.composeBody(run.issue.body, run.plan, state);
  await gh().patch(`/issues/${run.n}`, { body });
  run.state = state;
  run.issue.body = body;
  if (logLine) await comment(run.n, logLine);
  return state;
}

const comment = (num, text) => gh().post(`/issues/${num}/comments`, { body: `${C.LOG_MARK}\n${text}` });

async function ensureLabels() {
  const colors = { "orch:go": "0e8a16", "orch:cancel": "b60205", "orch:run": "1d76db", "orch:blocked": "d93f0b", "orch:done": "5319e7" };
  for (const [name, color] of Object.entries(colors)) {
    try {
      await gh().post("/labels", { name, color });
    } catch (e) {
      if (e.status !== 422) throw e; // 422 = already exists
    }
  }
}

async function setLabels(n, add = [], remove = []) {
  if (add.length) await gh().post(`/issues/${n}/labels`, { labels: add });
  for (const l of remove) {
    try {
      await gh().del(`/issues/${n}/labels/${encodeURIComponent(l)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
}

async function dispatchWork(run, mode) {
  await ro().post("/actions/workflows/claude-work.yml/dispatches", {
    ref: "main",
    inputs: { issue: String(run.n), mode, step: String(run.state.step) },
  });
}

async function block(run, reason, url, kind = "work") {
  await save(
    run,
    { status: "blocked", reason, blockKind: kind },
    `⛔ **중단** (Step ${run.state?.step ?? "-"}): ${reason}${url ? `\n${url}` : ""}\n\n` +
      "원인을 해결한 뒤 `orch:go` 라벨을 다시 붙이면 재개합니다. 취소하려면 `orch:cancel` 라벨을 붙이세요.",
  );
  await setLabels(run.n, [C.LABELS.blocked], []);
  await notify(`⛔ Run #${run.n} 중단`, `${run.plan?.goal ?? ""} — ${reason}`, run.issue.html_url);
}

// ---------------------------------------------------------------- start / resume / cancel

async function start(run, sender) {
  if (run.issue.user.login !== OWNER || sender !== OWNER) {
    log(`ignored: issue author ${run.issue.user.login}, sender ${sender}, owner ${OWNER}`);
    return;
  }
  await ensureLabels();
  await setLabels(run.n, [], [C.LABELS.go]);
  if (!run.plan) {
    await comment(run.n, `❌ 계획을 읽을 수 없어 시작하지 않았습니다: ${run.planError}`);
    return;
  }
  const st = run.state;
  if (st && ["implementing", "reviewing", "fixing"].includes(st.status)) {
    await comment(run.n, `ℹ️ 이미 진행 중입니다 (${st.status}, Step ${st.step}).`);
    return;
  }
  if (st?.status === "awaiting_merge") {
    await comment(run.n, `ℹ️ 모든 스텝이 끝나 최종 PR #${st.finalPr} 머지를 기다리고 있습니다.`);
    return;
  }

  // Resume from blocked
  if (st?.status === "blocked") {
    const pr = st.pr ? await gh().get(`/pulls/${st.pr}`, { allow404: true }) : null;
    if (st.blockKind === "review" && pr?.state === "open") {
      await save(run, { status: "reviewing", reason: null, reviewRequestedAt: now(), nudged: [pr.head.sha], claudeReviewFor: null },
        `▶️ 재개: PR #${pr.number} 재검증을 요청했습니다.`);
      await gh().post(`/issues/${pr.number}/comments`, { body: "@codex review" });
    } else {
      if (pr?.state === "open") {
        await gh().post(`/issues/${pr.number}/comments`, { body: `${C.LOG_MARK}\n재개로 이 스텝을 처음부터 다시 구현하므로 PR을 닫습니다.` });
        await gh().patch(`/pulls/${pr.number}`, { state: "closed" });
      }
      await save(run, { status: "implementing", attempt: (st.attempt ?? 1) + 1, retries: 0, pr: null, reason: null, requestedAt: now() },
        `▶️ 재개: Step ${st.step}을 새로 구현합니다 (시도 ${(st.attempt ?? 1) + 1}).`);
      await dispatchWork(run, "implement");
    }
    await setLabels(run.n, [C.LABELS.run], [C.LABELS.blocked]);
    return;
  }

  // Fresh start
  const main = await gh().get("/git/ref/heads/main");
  try {
    await gh().post("/git/refs", { ref: `refs/heads/${C.runBranch(run.n)}`, sha: main.object.sha });
  } catch (e) {
    if (e.status !== 422) throw e; // already exists -> reuse
  }
  await save(
    run,
    { v: 1, status: "implementing", step: 1, attempt: 1, retries: 0, pr: null, finalPr: null, passed: {}, startedAt: now(), requestedAt: now(), reason: null },
    `🚀 시작: ${run.plan.steps.length}개 스텝, 통합 브랜치 \`${C.runBranch(run.n)}\`. Step 1 구현을 Claude에게 맡겼습니다.`,
  );
  await setLabels(run.n, [C.LABELS.run], [C.LABELS.blocked, C.LABELS.done]);
  await dispatchWork(run, "implement");
}

async function cancel(run, sender, why) {
  if (sender && sender !== OWNER) return;
  const st = run.state;
  if (!st || ["cancelled", "done"].includes(st.status)) return;
  if (st.pr) {
    const pr = await gh().get(`/pulls/${st.pr}`, { allow404: true });
    if (pr?.state === "open") await gh().patch(`/pulls/${pr.number}`, { state: "closed" });
  }
  await save(run, { status: "cancelled", reason: why }, `🚫 취소: ${why}`);
  await setLabels(run.n, [], [C.LABELS.run, C.LABELS.go, C.LABELS.cancel]);
}

// ---------------------------------------------------------------- review evaluation

async function evaluatePR(prNumber, { reviewRunFailed = false } = {}) {
  const pr = await gh().get(`/pulls/${prNumber}`, { allow404: true });
  if (!pr || pr.state !== "open" || pr.user.login !== OWNER) return;
  const link = C.parsePrMarker(pr.body);
  if (!link) return;
  const run = await loadRun(link.issue);
  const st = run?.state;
  if (!run?.plan || !st || st.status !== "reviewing" || st.pr !== pr.number || st.step !== link.step) {
    log(`PR #${prNumber}: not the active review (state=${st?.status} pr=${st?.pr})`);
    return;
  }
  const comments = await gh().all(`/issues/${pr.number}/comments`);
  const codex = C.codexVerdict(comments, pr.head.sha);
  const ci = C.ciVerdict(await ro().all(`/commits/${pr.head.sha}/check-runs`), SELF_CHECKS);

  // Codex unavailable (e.g. usage limit) -> independent Claude (Opus) review in a separate workflow.
  let review = codex;
  if (codex.result === "error") {
    const cr = C.claudeReviewVerdict(comments, pr.head.sha);
    log(`PR #${pr.number}: codex=error(${codex.status}) -> claude review ${cr.result}`);
    if (cr.result === "none") {
      if (reviewRunFailed && st.claudeReviewFor === pr.head.sha) {
        return block(run, "Claude 대체 검수 워크플로가 판정 없이 실패했습니다.", pr.html_url, "review");
      }
      if (st.claudeReviewFor !== pr.head.sha) {
        await ro().post("/actions/workflows/claude-review.yml/dispatches", {
          ref: "main",
          inputs: { issue: String(run.n), pr: String(pr.number), sha: pr.head.sha },
        });
        await save(run, { claudeReviewFor: pr.head.sha, reviewRequestedAt: now() },
          `🔁 Codex 리뷰를 쓸 수 없어(status=${codex.status}) Claude(Opus) 대체 검수를 요청했습니다 (PR #${pr.number}).`);
      }
      return { run, pr, codex, fallback: true };
    }
    if (cr.result === "error") return block(run, "Claude 대체 검수가 판정을 내지 못했습니다.", cr.url ?? pr.html_url, "review");
    review = cr;
  }

  const d = C.decide(review, ci, { requireCi: env.REQUIRE_CI !== "false" });
  log(`PR #${pr.number} head ${pr.head.sha.slice(0, 7)}: review=${review.source ?? "codex"}:${review.result} ci=${ci.result} -> ${d.action}`);

  if (d.action === "wait") return { run, pr, codex, fallback: review !== codex };
  if (d.action === "block") return block(run, d.reason, codex.url ?? pr.html_url, "review");
  if (d.action === "pass") return onPass(run, pr, review.source === "claude" ? "Claude(Opus) 대체 검수 PASS" : "Codex 지적 없음");
  return onFail(run, pr, d.reason);
}

async function onPass(run, pr, reviewNote = "Codex 지적 없음") {
  const st = run.state;
  const step = run.plan.steps.find((s) => s.id === st.step);
  try {
    await gh().put(`/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha: pr.head.sha, // refuse if the head moved since we judged it
      commit_title: `[run #${run.n}] Step ${step.id}: ${step.title} (#${pr.number})`,
    });
  } catch (e) {
    return block(run, `스텝 PR 머지 실패 (${e.status}): ${C.oneLine(e.message, 200)}`, pr.html_url, "work");
  }
  const passed = { ...(st.passed ?? {}), [step.id]: pr.number };
  const total = run.plan.steps.length;

  if (step.id < total) {
    await save(run, { status: "implementing", step: step.id + 1, attempt: 1, retries: 0, pr: null, passed, requestedAt: now() },
      `✅ Step ${step.id} 통과 (#${pr.number}, ${reviewNote} + CI 통과) → Step ${step.id + 1} 구현 시작`);
    await dispatchWork(run, "implement");
    return;
  }

  const final = await gh().post("/pulls", {
    title: `[orch] ${run.plan.goal}`,
    head: C.runBranch(run.n),
    base: "main",
    body: C.finalPrBody(run.n, run.plan, passed),
  });
  await save(run, { status: "awaiting_merge", pr: null, passed, finalPr: final.number },
    `🎉 전체 ${total}개 스텝 통과. 최종 PR #${final.number}을 열었습니다. **머지는 직접 승인해 주세요.**`);
  await notify(`✅ Run #${run.n} 완료`, `${run.plan.goal} — 최종 PR #${final.number} 머지 승인 필요`, final.html_url);
}

async function onFail(run, pr, reason) {
  const st = run.state;
  const max = run.plan.max_retries;
  if ((st.retries ?? 0) >= max) {
    return block(run, `검증 ${st.retries + 1}회 연속 실패 (${reason})`, pr.html_url, "work");
  }
  await save(run, { status: "fixing", retries: (st.retries ?? 0) + 1, fixFrom: pr.head.sha, requestedAt: now() },
    `🔁 Step ${st.step} 검증 실패: ${reason}. Claude에게 수정을 맡겼습니다 (${(st.retries ?? 0) + 1}/${max}).`);
  await dispatchWork(run, "fix");
}

// ---------------------------------------------------------------- watchdog

async function watchdog() {
  const issues = await gh().all(`/issues?labels=${encodeURIComponent(C.LABELS.run)}&state=open`);
  for (const it of issues.filter((i) => !i.pull_request)) {
    try {
      await watchOne(it.number);
    } catch (e) {
      log(`watchdog #${it.number} error: ${e.message}`);
    }
  }
}

async function watchOne(n) {
  let run = await loadRun(n);
  const st = run?.state;
  if (!st || !run.plan) return;

  if (st.status === "reviewing" && st.pr) {
    const r = await evaluatePR(st.pr);          // re-evaluate in case an event was missed
    run = await loadRun(n);
    if (run.state.status !== "reviewing" || !r) return;
    const head = r.pr.head.sha;
    const nudged = run.state.nudged ?? [];
    if (!r.fallback && r.codex.result === "none" && minutesSince(run.state.reviewRequestedAt) > NUDGE_AFTER_MIN && !nudged.includes(head)) {
      await gh().post(`/issues/${st.pr}/comments`, { body: "@codex review" });
      await save(run, { nudged: [...nudged, head] }, `🔔 ${NUDGE_AFTER_MIN}분 동안 Codex 판정이 없어 리뷰를 다시 요청했습니다 (PR #${st.pr}).`);
      return;
    }
    if (minutesSince(run.state.updatedAt) > REVIEW_IDLE_MIN) {
      await block(run, `${REVIEW_IDLE_MIN}분 동안 Codex/CI 판정이 없습니다.`, r.pr.html_url, "review");
    }
    return;
  }

  if (["implementing", "fixing"].includes(st.status) && minutesSince(st.requestedAt) > WORK_IDLE_MIN) {
    const active = await ro().all("/actions/workflows/claude-work.yml/runs?status=in_progress");
    const queued = await ro().all("/actions/workflows/claude-work.yml/runs?status=queued");
    if ([...active, ...queued].some((w) => (w.display_title ?? "").includes(`#${n} `))) return;
    await block(run, `Claude 작업이 ${Math.round(minutesSince(st.requestedAt))}분째 결과가 없습니다.`, null, "work");
    return;
  }

  if (st.status === "awaiting_merge" && st.finalPr) {
    const pr = await gh().get(`/pulls/${st.finalPr}`, { allow404: true });
    if (pr?.merged_at) {
      await save(run, { status: "done" }, `🏁 최종 PR #${pr.number}이 머지되어 완료 처리했습니다.`);
      await setLabels(n, [C.LABELS.done], [C.LABELS.run]);
      if (run.issue.state === "open") await gh().patch(`/issues/${n}`, { state: "closed", state_reason: "completed" });
    } else if (pr?.state === "closed") {
      await save(run, { status: "cancelled", reason: "최종 PR이 머지 없이 닫힘" }, "🚫 최종 PR이 머지 없이 닫혀 run을 종료했습니다.");
      await setLabels(n, [], [C.LABELS.run]);
    }
  }
}

// ---------------------------------------------------------------- event router (orchestrator.yml)

async function onEvent() {
  const name = env.GITHUB_EVENT_NAME;
  const ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  log(`event ${name}/${ev.action ?? "-"}`);

  if (name === "issues") {
    const run = await loadRun(ev.issue.number);
    if (!run) return;
    if (ev.action === "labeled" && ev.label?.name === C.LABELS.go) return start(run, ev.sender?.login);
    if (ev.action === "labeled" && ev.label?.name === C.LABELS.cancel) return cancel(run, ev.sender?.login, "orch:cancel 라벨");
    if (ev.action === "closed") {
      if (run.state?.status === "awaiting_merge") return watchOne(run.n); // closed by the final merge -> done
      return cancel(run, ev.sender?.login, "Issue가 닫힘");
    }
    return;
  }

  if (name === "issue_comment") {
    if (ev.issue?.pull_request && C.isTrustedCodex(ev.comment?.user)) return evaluatePR(ev.issue.number);
    return;
  }

  if (name === "workflow_run") {
    const wr = ev.workflow_run;
    // With `run-name`, workflow_run.name is the run title ("claude-review #1 pr 2"); use the workflow's name.
    const wf = ev.workflow?.name ?? wr.name;
    if (wf === "claude-review") {
      const m = /#(\d+) pr (\d+)/.exec(wr.display_title ?? "");
      return m ? evaluatePR(Number(m[2]), { reviewRunFailed: wr.conclusion !== "success" }) : undefined;
    }
    if (wf === "claude-work") {
      // The publish job handles normal results. This only catches a run cancelled before publish could act.
      const m = /#(\d+) /.exec(wr.display_title ?? "");
      if (!m || wr.conclusion === "success") return;
      const run = await loadRun(m[1]);
      const st = run?.state;
      if (st && ["implementing", "fixing"].includes(st.status) && Date.parse(wr.created_at) >= Date.parse(st.requestedAt) - 60000) {
        return block(run, `Claude 작업 워크플로가 ${wr.conclusion} 상태로 끝났습니다.`, wr.html_url, "work");
      }
      return;
    }
    for (const p of wr.pull_requests ?? []) await evaluatePR(p.number);
    return;
  }

  if (name === "workflow_dispatch" && /^\d+$/.test(env.INPUT_PR ?? "")) {
    return evaluatePR(Number(env.INPUT_PR), { reviewRunFailed: true });
  }
  if (name === "schedule" || name === "workflow_dispatch") return watchdog();
}

// ---------------------------------------------------------------- claude-work: prepare / commit / publish

function expectedStatus(mode) {
  return mode === "fix" ? "fixing" : "implementing";
}

async function prepare() {
  const n = Number(env.ISSUE), mode = env.MODE, step = Number(env.STEP);
  const run = await loadRun(n);
  const st = run?.state;
  if (!run?.plan || !st || st.status !== expectedStatus(mode) || st.step !== step) {
    log(`skip: state=${st?.status} step=${st?.step} (expected ${expectedStatus(mode)} step ${step})`);
    setOutput("skip", "true");
    return;
  }

  let branch, prompt;
  if (mode === "implement") {
    branch = C.stepBranch(n, step, st.attempt ?? 1);
    git("fetch", "origin", C.runBranch(n));
    git("checkout", "-B", branch, `origin/${C.runBranch(n)}`);
    prompt = C.implementPrompt(run.plan, step);
  } else {
    const pr = await gh().get(`/pulls/${st.pr}`);
    branch = pr.head.ref;
    git("fetch", "origin", branch);
    git("checkout", "-B", branch, `origin/${branch}`);
    const head = pr.head.sha;
    const inline = (await gh().all(`/pulls/${pr.number}/comments`))
      .filter((c) => C.isTrustedCodex(c.user) && (c.commit_id === head || c.original_commit_id === head))
      .map((c) => ({ path: c.path, line: c.line ?? c.original_line, body: c.body }));
    const reviews = (await gh().all(`/pulls/${pr.number}/reviews`))
      .filter((r) => C.isTrustedCodex(r.user) && r.commit_id === head)
      .map((r) => r.body ?? "");
    const cr = C.claudeReviewVerdict(await gh().all(`/issues/${pr.number}/comments`), head);
    if (cr.result === "fail") {
      inline.push(...cr.findings.map((f) => ({ path: f.path, line: f.line, body: f.body })));
      if (cr.summary) reviews.push(`(Claude 대체 검수) ${cr.summary}`);
    }
    const ci = C.ciVerdict(await ro().all(`/commits/${head}/check-runs`), SELF_CHECKS);
    prompt = C.fixPrompt(run.plan, step, {
      round: st.retries, maxRetries: run.plan.max_retries, findings: inline, reviewBodies: reviews, ciFailed: ci.failed,
    });
  }

  setOutput("skip", "false");
  setOutput("branch", branch);
  setOutput("start_sha", git("rev-parse", "HEAD"));
  setOutput("model_args", run.plan.model ? `--model ${run.plan.model}` : "");
  setOutput("prompt", prompt);
}

function readNote(file) {
  try {
    return fs.readFileSync(path.join(".orch", file), "utf8").trim();
  } catch {
    return "";
  }
}

async function commitAndPush() {
  const branch = env.BRANCH, startSha = env.START_SHA, n = env.ISSUE, step = env.STEP;
  const blocked = readNote("BLOCKED.md");
  const summary = readNote("SUMMARY.md");
  fs.rmSync(".orch", { recursive: true, force: true });
  setOutput("summary", summary.slice(0, 6000));

  if (blocked) {
    setOutput("blocked", blocked.slice(0, 1500));
    setOutput("changed", "false");
    return;
  }

  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  if (staged) git("commit", "-m", `Run #${n} step ${step}: ${env.MODE === "fix" ? "address review findings" : "implement"}`);

  const changedFiles = git("diff", "--name-only", `${startSha}..HEAD`).split("\n").filter(Boolean);
  const prot = C.touchesProtected(changedFiles);
  if (prot.length) {
    setOutput("blocked", `보호 경로를 수정해 푸시하지 않았습니다: ${prot.join(", ")}`);
    setOutput("changed", "false");
    return;
  }
  if (changedFiles.length === 0) {
    setOutput("changed", "false");
    return;
  }
  // claude-code-action rewrites the checkout's git credentials, so push with an explicit token URL.
  // (BOT_PAT is a registered secret, so Actions masks it in any log output.)
  const url = env.BOT_PAT ? `https://x-access-token:${env.BOT_PAT}@github.com/${REPO}.git` : "origin";
  git("push", url, `HEAD:refs/heads/${branch}`);
  setOutput("changed", "true");
}

async function resolveCodexThreads(prNumber) {
  const [owner, name] = REPO.split("/");
  const data = await gh().graphql(
    `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
      reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login}}}}}}}}`,
    { owner, name, pr: prNumber },
  );
  const threads = data.repository.pullRequest.reviewThreads.nodes.filter(
    (t) => !t.isResolved && (t.comments.nodes[0]?.author?.login ?? "").startsWith("chatgpt-codex-connector"),
  );
  for (const t of threads) {
    await gh().graphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id: t.id });
  }
  return threads.length;
}

async function publish() {
  if (env.SKIP === "true") return log("prepare skipped; nothing to publish");
  const n = Number(env.ISSUE), mode = env.MODE, step = Number(env.STEP);
  const run = await loadRun(n);
  const st = run?.state;
  if (!run?.plan || !st || st.status !== expectedStatus(mode) || st.step !== step) {
    return log(`state moved on (${st?.status}); not publishing`);
  }
  if (env.WORK_RESULT !== "success") {
    return block(run, `Claude 작업 실행이 실패했습니다 (${env.WORK_RESULT}).`, RUN_URL, "work");
  }
  if (env.BLOCKED) return block(run, `Claude 중단 보고: ${C.oneLine(env.BLOCKED, 600)}`, RUN_URL, "work");
  if (env.CHANGED !== "true") {
    return block(run, mode === "fix" ? "수정 요청을 받았지만 새 커밋이 없습니다." : "변경 사항 없이 끝났습니다.", RUN_URL, "work");
  }

  if (mode === "implement") {
    const step0 = run.plan.steps.find((s) => s.id === step);
    const pr = await gh().post("/pulls", {
      title: `[run #${n}] Step ${step}: ${step0.title}`,
      head: env.BRANCH,
      base: C.runBranch(n),
      body: C.prBody(n, run.plan, step, env.SUMMARY),
    });
    await save(run, { status: "reviewing", pr: pr.number, reviewRequestedAt: now(), nudged: [] },
      `📝 Step ${step} PR #${pr.number}을 열었습니다. Codex 리뷰와 CI를 기다립니다.`);
    return;
  }

  const resolved = await resolveCodexThreads(st.pr).catch((e) => (log("resolve threads failed", e.message), 0));
  if (env.SUMMARY) await gh().post(`/issues/${st.pr}/comments`, { body: `${C.LOG_MARK}\n**수정 ${st.retries}회차 반영**\n\n${env.SUMMARY}` });
  await gh().post(`/issues/${st.pr}/comments`, { body: "@codex review" });
  await save(run, { status: "reviewing", reviewRequestedAt: now(), nudged: [] },
    `🔍 Step ${step} 수정 커밋을 푸시하고 재검증을 요청했습니다 (PR #${st.pr}, 기존 Codex 스레드 ${resolved}건 resolve).`);
}

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- claude-review: prepare / publish
// Runs with the workflow GITHUB_TOKEN only (no owner PAT): reads the plan, posts one verdict comment.

async function reviewPrepare() {
  const n = Number(env.ISSUE), prNumber = Number(env.PR), sha = env.SHA;
  const run = await loadRun(n, ro());
  const st = run?.state;
  const pr = await ro().get(`/pulls/${prNumber}`, { allow404: true });
  if (!run?.plan || !st || st.status !== "reviewing" || st.pr !== prNumber || pr?.head.sha !== sha) {
    log(`skip review: state=${st?.status} pr=${st?.pr} head=${pr?.head.sha?.slice(0, 7)}`);
    setOutput("skip", "true");
    return;
  }
  setOutput("skip", "false");
  setOutput("prompt", C.reviewPrompt(run.plan, st.step, `origin/${pr.base.ref}`));
}

async function reviewPublish() {
  if (env.SKIP === "true") return;
  const sha = env.SHA;
  let parsed = null;
  try {
    parsed = env.CLAUDE_OUTCOME === "success" ? C.parseReviewFile(fs.readFileSync(".orch/REVIEW.json", "utf8")) : null;
  } catch { parsed = null; }
  const verdict = parsed?.verdict ?? "ERROR";
  const summary = parsed?.summary ?? `검수 결과 파일이 없거나 형식이 잘못되었습니다 (Claude 실행 결과: ${env.CLAUDE_OUTCOME}).`;
  await ro().post(`/issues/${env.PR}/comments`, {
    body: C.claudeReviewComment({ sha, verdict, summary, findings: parsed?.findings ?? [], runUrl: RUN_URL }),
  });
  log(`claude review ${verdict} for ${sha.slice(0, 7)}`);
}

export const commands = { event: onEvent, prepare, commit: commitAndPush, publish, watchdog, "review-prepare": reviewPrepare, "review-publish": reviewPublish };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (!commands[cmd]) {
    console.error(`usage: main.mjs ${Object.keys(commands).join("|")}`);
    process.exit(2);
  }
  commands[cmd]().catch(async (e) => {
    console.error(e);
    await notify("⚠️ orchestrator 오류", `${cmd}: ${e.message}`, RUN_URL);
    process.exit(1);
  });
}
