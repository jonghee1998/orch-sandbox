// AI usage snapshot for the dashboard (usage.yml, hourly).
//   Claude: subscription-wide 5h / 7d utilization from a Claude Code `rate_limit_event` (stream-json).
//   Codex : 5h / weekly % from `codex app-server` account/rateLimits/read (codex-limits.mjs), using a
//           login kept encrypted in the Actions cache (usage.yml / codex-login.yml). Plus what GitHub shows:
//           last review time and whether Codex answered "usage limits" recently.
// The snapshot lives in one Issue labelled `orch:usage` as <!-- orch-usage:v1 {...} -->.
//   node scripts/orch/usage.mjs publish <stream-json file | ->

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "./github.mjs";
import { CODEX_BOT } from "./core.mjs";

export const USAGE_LABEL = "orch:usage";
const MARK_RE = /<!-- orch-usage:v1 ([\s\S]*?) -->/;
const LIMIT_RE = /usage limits?/i;

// rate_limit_event utilization is a 0–1 fraction (same as the anthropic-ratelimit-unified-* headers).
const pct = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) / 10 : null);
const iso = (sec) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);

/** Last rate_limit_event in a Claude Code stream-json transcript → {fiveHour, sevenDay, status} or null. */
export function claudeFromStream(text) {
  let info = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const j = JSON.parse(line);
      if (j?.type === "rate_limit_event" && j.rate_limit_info) info = j.rate_limit_info;
    } catch { /* ignore partial lines */ }
  }
  if (!info) return null;
  const w = info.unifiedWindows ?? {};
  const win = (x) => (x ? { pct: pct(x.utilization), resetsAt: iso(x.resetsAt), status: String(x.status ?? "") || null } : null);
  return { status: String(info.status ?? "") || null, fiveHour: win(w.five_hour), sevenDay: win(w.seven_day) };
}

/** Merge this run's Codex quota read (or its absence) with the previous snapshot. */
export function codexQuota(read, prev, nowIso, note) {
  if (read?.ok) return { quota: { allowed: read.allowed ?? null, fiveHour: read.fiveHour ?? null, weekly: read.weekly ?? null, byLimit: read.byLimit ?? [] }, quotaCheckedAt: nowIso, quotaError: null, needsLogin: false };
  return {
    quota: prev?.quota ?? null,
    quotaCheckedAt: prev?.quotaCheckedAt ?? null,
    quotaError: read?.error ?? note ?? prev?.quotaError ?? null,
    needsLogin: read ? !!read.needsLogin : note === "로그인 필요" ? true : !!prev?.needsLogin,
  };
}

/** Codex activity from PR/issue comments of the trusted bot. */
export function codexFromComments(comments, nowMs = Date.now()) {
  const mine = (comments ?? []).filter((c) => c?.user?.login === CODEX_BOT.login && c?.user?.id === CODEX_BOT.id);
  const at = (c) => c.updated_at ?? c.created_at ?? null;
  const limits = mine.filter((c) => LIMIT_RE.test(c.body ?? "")).map(at).filter(Boolean).sort();
  const reviews = mine.filter((c) => /"status":"completed"/.test(c.body ?? "")).map(at).filter(Boolean).sort();
  const lastLimitAt = limits.at(-1) ?? null;
  const lastReviewAt = reviews.at(-1) ?? null;
  // "limited" while the latest signal is a limit message and it is less than 24h old.
  const limited = !!lastLimitAt && (!lastReviewAt || lastLimitAt > lastReviewAt) && nowMs - Date.parse(lastLimitAt) < 24 * 3600 * 1000;
  return { limited, lastLimitAt, lastReviewAt };
}

export function readUsage(body) {
  const m = MARK_RE.exec(body ?? "");
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const kst = (isoStr) => (isoStr ? new Date(Date.parse(isoStr) + 9 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ") : "-");

export function usageBody(u) {
  const c = u.claude;
  const row = (name, w) => `| ${name} | ${w?.pct ?? "?"}% | ${kst(w?.resetsAt)} |`;
  return [
    "엔진이 1시간마다 갱신하는 AI 사용량입니다. 상황판 AI 팀 탭에 표시됩니다. 직접 수정하지 마세요.",
    "",
    "### Claude (구독 전체, 직접 대화 포함)",
    c ? ["| 구간 | 사용률 | 리셋 (한국시간) |", "| --- | --- | --- |", row("5시간", c.fiveHour), row("7일", c.sevenDay)].join("\n")
      : `확인 불가${u.claudeError ? ` (${u.claudeError})` : ""}`,
    `_확인: ${kst(u.claudeCheckedAt)}_`,
    "",
    "### Codex",
    u.codex.quota ? ["| 구간 | 사용률 | 리셋 (한국시간) |", "| --- | --- | --- |", row("5시간", u.codex.quota.fiveHour), row("주간", u.codex.quota.weekly)].join("\n")
      : "사용률 확인 불가",
    `_확인: ${kst(u.codex.quotaCheckedAt)}${u.codex.quotaError ? ` · 이번 조회: ${u.codex.quotaError}` : ""}_`,
    u.codex.needsLogin ? "- 🔑 **폰 로그인 필요** — Actions → `codex-login` → Run workflow 후 이 Issue에 올라오는 코드로 승인" : "",
    `- 상태: ${u.codex.limited ? "⚠️ 한도 소진 — Opus가 대체 검수 중" : "정상"}`,
    `- 마지막 리뷰 완료: ${kst(u.codex.lastReviewAt)} · 마지막 한도 응답: ${kst(u.codex.lastLimitAt)}`,
    "",
    `<!-- orch-usage:v1 ${JSON.stringify(u)} -->`,
  ].join("\n");
}

async function publish(file) {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const gh = client(env.GH_WRITE_TOKEN || env.READ_TOKEN, repo);
  const now = new Date();
  const text = file && file !== "-" && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const claude = claudeFromStream(text);

  const issues = await gh.get(`/issues?labels=${encodeURIComponent(USAGE_LABEL)}&state=open&per_page=5`);
  const existing = (issues ?? []).find((i) => !i.pull_request) ?? null;
  const prev = readUsage(existing?.body);

  // Codex comments live on PRs. The repo-wide comment listing proved incomplete with the workflow token,
  // so read the 15 most recently updated PRs directly.
  const comments = [];
  try {
    const prs = (await gh.get("/pulls?state=all&sort=updated&direction=desc&per_page=15")) ?? [];
    for (const pr of prs) comments.push(...((await gh.get(`/issues/${pr.number}/comments?per_page=100`)) ?? []));
  } catch (e) {
    console.log(`[usage] codex review history unavailable: ${e.status ?? e.message}`); // quota read still counts
  }
  const activity = codexFromComments(comments, now.getTime());
  let read = null;
  try { if (env.CODEX_LIMITS_FILE && fs.existsSync(env.CODEX_LIMITS_FILE)) read = JSON.parse(fs.readFileSync(env.CODEX_LIMITS_FILE, "utf8")); } catch { read = null; }
  const q = codexQuota(read, prev?.codex, now.toISOString(), env.CODEX_NOTE || null);
  const exhausted = q.quota?.allowed === false || (q.quota?.weekly?.pct ?? 0) >= 100 || (q.quota?.fiveHour?.pct ?? 0) >= 100;
  const codex = { ...activity, ...q, limited: activity.limited || (!!q.quota && exhausted) };

  // Keep the last good Claude value when this probe could not read one (skipped or failed).
  const u = {
    v: 1,
    updatedAt: now.toISOString(),
    claude: claude ?? prev?.claude ?? null,
    claudeCheckedAt: claude ? now.toISOString() : prev?.claudeCheckedAt ?? null,
    claudeError: claude ? null : env.PROBE_NOTE || "이번 확인에서 한도 정보를 받지 못함",
    codex: { ...codex, checkedAt: now.toISOString() },
  };
  const body = usageBody(u);
  if (existing) await gh.patch(`/issues/${existing.number}`, { body });
  else {
    try { await gh.post("/labels", { name: USAGE_LABEL, color: "c2e0c6", description: "AI 사용량 스냅샷 (자동)" }); } catch (e) { if (e.status !== 422) throw e; }
    await gh.post("/issues", { title: "[orch] AI 사용량 (자동 갱신)", body, labels: [USAGE_LABEL] });
  }
  console.log(`[usage] claude=${claude ? `${claude.fiveHour?.pct}%/5h ${claude.sevenDay?.pct}%/7d` : "none"} codex.limited=${codex.limited}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "publish") { console.error("usage: usage.mjs publish <stream-json file|->"); process.exit(2); }
  publish(process.argv[3]).catch((e) => { console.error(e); process.exit(1); });
}
