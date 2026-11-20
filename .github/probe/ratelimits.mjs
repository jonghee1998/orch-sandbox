// Ask a logged-in `codex app-server` for account/rateLimits/read and print only the numbers.
import { spawn } from "node:child_process";
const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
const done = (code) => { p.kill(); process.exit(code); };
setTimeout(() => { console.log("timeout"); done(1); }, 30000);
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 0) { send({ method: "initialized" }); setTimeout(() => send({ id: 1, method: "account/rateLimits/read", params: {} }), 500); }
    if (m.id === 1) {
      if (m.error) { console.log("error", JSON.stringify(m.error).slice(0, 300)); return done(1); }
      const r = m.result?.rateLimits ?? m.result;
      const w = (x) => x && { usedPercent: x.usedPercent ?? x.used_percent, windowMins: x.windowDurationMins ?? x.window_minutes, resetsAt: x.resetsAt ?? x.resets_at };
      console.log("RATE_LIMITS", JSON.stringify({ keys: Object.keys(m.result ?? {}), primary: w(r?.primary), secondary: w(r?.secondary) }));
      return done(0);
    }
  }
});
send({ id: 0, method: "initialize", params: { clientInfo: { name: "orch-usage-probe", title: "orch usage probe", version: "0.1" } } });
