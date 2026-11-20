import test from "node:test";
import assert from "node:assert/strict";
import { claudeFromStream, codexFromComments, readUsage, usageBody } from "./usage.mjs";
import { CODEX_BOT } from "./core.mjs";

const EVENT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795219200,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":1795219200,"status":"allowed"},"seven_day":{"utilization":0.21,"resetsAt":1795705200,"status":"allowed"}}}}';

test("claudeFromStream: last rate_limit_event, fraction → percent, epoch → ISO", () => {
  const text = ['{"type":"system","subtype":"init"}', "not json", EVENT, '{"type":"result"}'].join("\n");
  const c = claudeFromStream(text);
  assert.equal(c.status, "allowed");
  assert.deepEqual(c.fiveHour, { pct: 11, resetsAt: "2026-11-21T00:00:00.000Z", status: "allowed" });
  assert.equal(c.sevenDay.pct, 21);
  assert.equal(claudeFromStream(""), null);
  assert.equal(claudeFromStream('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}').fiveHour, null, "old CLI without windows");
});

test("codexFromComments: trusted bot only; limited until a newer completed review", () => {
  const bot = { login: CODEX_BOT.login, id: CODEX_BOT.id };
  const now = Date.parse("2026-11-21T00:00:00Z");
  const c = (user, body, at) => ({ user, body, created_at: at, updated_at: at });
  const limit = c(bot, "You have reached your Codex usage limits for code reviews.", "2026-11-20T17:00:00Z");
  const done = (at) => c(bot, '<!-- codex-review-state:v1 {"code_review":{"status":"completed"}} -->', at);
  const fake = c({ login: CODEX_BOT.login, id: 1 }, "usage limits", "2026-11-20T23:00:00Z");
  assert.deepEqual(codexFromComments([done("2026-11-20T10:00:00Z"), limit, fake], now),
    { limited: true, lastLimitAt: "2026-11-20T17:00:00Z", lastReviewAt: "2026-11-20T10:00:00Z" });
  assert.equal(codexFromComments([limit, done("2026-11-20T18:00:00Z")], now).limited, false, "review after limit → recovered");
  assert.equal(codexFromComments([limit], Date.parse("2026-11-22T00:00:00Z")).limited, false, "stale after 24h");
});

test("usageBody/readUsage round-trip with human table", () => {
  const u = { v: 1, updatedAt: "2026-11-21T00:00:00Z", claude: claudeFromStream(EVENT), claudeCheckedAt: "2026-11-21T00:00:00Z", claudeError: null,
    codex: { limited: true, lastLimitAt: "2026-11-20T17:00:00Z", lastReviewAt: null, checkedAt: "2026-11-21T00:00:00Z" } };
  const body = usageBody(u);
  assert.match(body, /\| 5시간 \| 11% \| 11-21 09:00 \|/);
  assert.match(body, /한도 소진/);
  assert.deepEqual(readUsage(body), u);
  assert.equal(readUsage("nothing"), null);
});

import { codexQuota } from "./usage.mjs";
import { normalizeLimits } from "./codex-limits.mjs";

test("codex quota: app-server result normalized (no ids leak), kept on failure, login flag", () => {
  const n = normalizeLimits({ ordinaryUsageAllowed: false, accountId: "acct_secret", rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1795229741 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1795481550 } }, rateLimitsByLimitId: { codex_review: { limitName: "Code review", secondary: { usedPercent: 100, resetsAt: 1795481550 } } } });
  assert.equal(JSON.stringify(n).includes("acct_secret"), false);
  assert.deepEqual(n.weekly, { pct: 100, windowMins: 10080, resetsAt: "2026-11-24T00:52:30.000Z" });
  assert.equal(n.byLimit[0].name, "Code review");
  const ok = codexQuota({ ok: true, ...n }, null, "T1");
  assert.equal(ok.quota.weekly.pct, 100);
  assert.equal(ok.needsLogin, false);
  const kept = codexQuota({ ok: false, needsLogin: true, error: "로그인 필요" }, ok, "T2");
  assert.equal(kept.quota.weekly.pct, 100, "last good value kept");
  assert.equal(kept.quotaCheckedAt, "T1");
  assert.equal(kept.needsLogin, true);
  assert.equal(codexQuota(null, kept, "T3", "3시간 주기 아님").needsLogin, true, "skipped run keeps login state");
  assert.equal(codexQuota(null, null, "T3", "로그인 필요").needsLogin, true, "no stored login");
});
