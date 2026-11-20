// Read Codex rate limits through the official `codex app-server` JSON-RPC (account/rateLimits/read).
// Requires a logged-in Codex (~/.codex/auth.json) on this machine. Writes only numbers to <out>.
//   node scripts/orch/codex-limits.mjs <out.json>
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const iso = (sec) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const win = (x) =>
  x && typeof x === "object"
    ? { pct: typeof (x.usedPercent ?? x.used_percent) === "number" ? (x.usedPercent ?? x.used_percent) : null,
        windowMins: x.windowDurationMins ?? x.window_minutes ?? null,
        resetsAt: iso(x.resetsAt ?? x.resets_at) }
    : null;

/** app-server result → dashboard shape. Never includes account ids or tokens. */
export function normalizeLimits(result) {
  const r = result?.rateLimits ?? result ?? {};
  const byId = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object" ? result.rateLimitsByLimitId : {};
  const extra = Object.entries(byId).slice(0, 6).map(([id, v]) => ({
    id: String(id).slice(0, 40),
    name: typeof v?.limitName === "string" ? v.limitName.slice(0, 60) : null,
    primary: win(v?.primary),
    secondary: win(v?.secondary),
  }));
  return {
    allowed: typeof result?.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
    fiveHour: win(r.primary),
    weekly: win(r.secondary),
    byLimit: extra,
  };
}

export function readLimits({ bin = "codex", timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("app-server timeout")); }, timeoutMs);
    const finish = (fn, v) => { clearTimeout(timer); p.kill(); fn(v); };
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    p.on("error", (e) => finish(reject, e));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 0) {
          send({ method: "initialized" });
          setTimeout(() => send({ id: 1, method: "account/rateLimits/read", params: {} }), 500);
        } else if (m.id === 1) {
          if (m.error) finish(reject, Object.assign(new Error(String(m.error.message ?? "rpc error").slice(0, 200)), { rpc: true }));
          else finish(resolve, normalizeLimits(m.result));
        }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "orch-usage", title: "orch usage", version: "1.0" } } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  readLimits()
    .then((v) => { fs.writeFileSync(out, JSON.stringify({ ok: true, ...v })); console.log(`[codex] 5h=${v.fiveHour?.pct}% weekly=${v.weekly?.pct}%`); })
    .catch((e) => {
      const login = /auth|login|token|unauthor|401|403/i.test(e.message);
      fs.writeFileSync(out, JSON.stringify({ ok: false, needsLogin: login, error: login ? "로그인 필요" : "조회 실패" }));
      console.log(`[codex] failed: ${login ? "login required" : "error"}`);
    });
}
