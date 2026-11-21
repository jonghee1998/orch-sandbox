import test from "node:test";
import assert from "node:assert/strict";
import { formatTools, summarizeTools } from "./tools.mjs";
import * as C from "./core.mjs";

const use = (name, input = {}) => ({ type: "tool_use", name, input });
const msgs = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "text", text: "hi" }, use("Read", { file_path: "a" }), use("Skill", { skill: "verification-loop" })] } },
  { type: "assistant", message: { content: [use("Bash", { command: "npm run typecheck 2>&1 | tail" }), use("Bash", { command: "npm test" }), use("Bash", { command: "npm run build" }), use("Bash", { command: "ls" })] } },
  { type: "assistant", message: { content: [use("Task", { subagent_type: "build-error-resolver", prompt: "fix" }), use("Agent", {}), use("Edit", {})] } },
  { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
  { type: "result", num_turns: 17 },
];

test("summarizeTools: counts, skills, sub-agents, verification commands", () => {
  const s = summarizeTools(msgs);
  assert.equal(s.counts.Bash, 4);
  assert.deepEqual(s.skills, ["verification-loop"]);
  assert.deepEqual(s.agents, ["build-error-resolver", "general"]);
  assert.deepEqual(s.verify, ["npm typecheck", "npm test", "npm build"]);
  assert.equal(s.turns, 17);
  const line = formatTools(s);
  assert.match(line, /^🧰 도구: Bash 4/);
  assert.match(line, /스킬: `verification-loop`/);
  assert.match(line, /보조 에이전트: `build-error-resolver`, `general`/);
  assert.doesNotMatch(line, /\n/);
});

test("summarizeTools: empty / malformed input is safe", () => {
  assert.equal(formatTools(summarizeTools(null)), "");
  assert.equal(formatTools(summarizeTools([{ type: "assistant", message: { content: "x" } }])), "");
  const none = formatTools(summarizeTools([{ type: "assistant", message: { content: [use("Read")] } }]));
  assert.match(none, /스킬: 없음 \| 보조 에이전트: 없음 \| 검증 명령: 없음/);
});

test("prBody includes the tool line; summary extraction and ECC cell read it back", () => {
  const plan = C.validatePlan({ goal: "g", steps: [{ id: 1, title: "t", task: "x", done_when: ["d"] }] }).plan;
  const line = formatTools(summarizeTools(msgs));
  const body = C.prBody(5, plan, 1, "## 변경 요약\n- 바꿈", line);
  assert.match(body, /### 도구 사용 \(자동 기록\)\n🧰/);
  assert.equal(C.extractSummary(body).summary, "- 바꿈", "tool section never leaks into the report summary");
  assert.equal(C.eccCell(body), "verification-loop / build-error-resolver, general");
  assert.equal(C.eccCell(C.prBody(5, plan, 1, "s", "🧰 도구: Read 1 | 스킬: 없음 | 보조 에이전트: 없음 | 검증 명령: 없음")), "없음");
  assert.equal(C.eccCell("no record"), "-");
  assert.doesNotMatch(C.prBody(5, plan, 1, "s"), /도구 사용/);
});
