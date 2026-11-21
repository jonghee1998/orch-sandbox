// final-sync.yml helpers.
//   node final-sync.mjs resolve <file...>   → resolve allowed conflicts in place (exit 1 if not safe)
//   node final-sync.mjs report               → one PR comment with the result marker (GITHUB_TOKEN, PR, HEAD, OK, FILES, RUN_URL)
import fs from "node:fs";
import * as C from "./core.mjs";
import { client } from "./github.mjs";

const [cmd, ...args] = process.argv.slice(2);
const env = process.env;

if (cmd === "resolve") {
  for (const f of args) {
    if (!C.AUTO_RESOLVE_FILES.includes(f)) { console.error(`not auto-resolvable: ${f}`); process.exit(1); }
    const fixed = C.resolvePatchNotes(fs.readFileSync(f, "utf8"));
    if (fixed === null) { console.error(`unsafe conflict in ${f}`); process.exit(1); }
    fs.writeFileSync(f, fixed);
  }
} else if (cmd === "report") {
  const ok = env.OK === "true";
  const files = (env.FILES ?? "").split(/\s+/).filter(Boolean).slice(0, 20);
  const body = [
    C.finalSyncMarker({ head: env.HEAD, ok, files }),
    ok
      ? `🔀 main을 합쳐 충돌을 자동으로 정리했습니다${files.length ? ` (${files.join(", ")})` : ""}. CI를 다시 확인합니다.`
      : `⚠️ main과의 충돌을 자동으로 정리하지 못했습니다${files.length ? `: ${files.join(", ")}` : ""}. 사람이 풀어야 합니다.`,
    "",
    `[실행 로그](${env.RUN_URL})`,
  ].join("\n");
  await client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY).post(`/issues/${env.PR}/comments`, { body });
} else {
  console.error("usage: final-sync.mjs resolve <file...> | report");
  process.exit(2);
}
