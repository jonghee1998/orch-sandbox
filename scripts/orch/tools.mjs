// Summarize what the implementing Claude actually used, from claude-code-action's execution file
// (array of SDK messages). Written to the step PR so ECC skill / sub-agent use is visible and measurable.
//   node scripts/orch/tools.mjs <execution-output.json>   → GITHUB_OUTPUT tools=<one markdown line>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const VERIFY_RE = /\bnpm\s+(?:run\s+)?(typecheck|test|build|lint)\b|\bnpx\s+(?:--no-install\s+)?(tsc|eslint|vitest|jest)\b|\bnode\s+--test\b/;

function toolUses(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = m?.message?.content;
    if (m?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const c of content) if (c?.type === "tool_use" && typeof c.name === "string") out.push(c);
  }
  return out;
}

/** @returns {{counts: Record<string, number>, skills: string[], agents: string[], verify: string[], turns: number|null}} */
export function summarizeTools(messages) {
  const uses = toolUses(messages);
  const counts = {};
  const skills = new Set();
  const agents = new Set();
  const verify = new Set();
  for (const u of uses) {
    counts[u.name] = (counts[u.name] ?? 0) + 1;
    const input = u.input ?? {};
    if (u.name === "Skill") {
      const s = input.skill ?? input.command ?? input.name;
      if (typeof s === "string" && s.trim()) skills.add(s.trim().replace(/^\//, "").slice(0, 60));
    }
    if (u.name === "Task" || u.name === "Agent") {
      const a = input.subagent_type ?? input.agent ?? input.agent_type;
      agents.add(typeof a === "string" && a.trim() ? a.trim().slice(0, 60) : "general");
    }
    if (u.name === "Bash" && typeof input.command === "string") {
      const m = VERIFY_RE.exec(input.command);
      if (m) verify.add((m[1] ? `npm ${m[1]}` : m[2] ? `${m[2]}` : "node --test"));
    }
  }
  const result = (Array.isArray(messages) ? messages : []).find((m) => m?.type === "result");
  return {
    counts,
    skills: [...skills],
    agents: [...agents],
    verify: [...verify],
    turns: typeof result?.num_turns === "number" ? result.num_turns : null,
  };
}

/** One markdown line, safe for a step output. */
export function formatTools(s) {
  if (!s || !Object.keys(s.counts).length) return "";
  const top = Object.entries(s.counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ");
  const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "없음");
  return [
    `🧰 도구: ${top}${s.turns ? ` (턴 ${s.turns})` : ""}`,
    `스킬: ${list(s.skills)}`,
    `보조 에이전트: ${list(s.agents)}`,
    `검증 명령: ${list(s.verify)}`,
  ].join(" | ").replace(/[\r\n]+/g, " ").slice(0, 900);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let line = "";
  try {
    const file = process.argv[2];
    if (file && fs.existsSync(file)) line = formatTools(summarizeTools(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch (e) {
    console.error(`[tools] could not summarize: ${e.message}`);
  }
  console.log(`[tools] ${line || "(no tool record)"}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tools=${line}\n`);
}
