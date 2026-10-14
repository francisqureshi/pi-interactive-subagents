/** Deterministic Pi CLI stand-in: finish a turn without calling subagent_done. */
import { appendFileSync, writeFileSync } from "node:fs";
import subagentDone from "../../pi-extension/subagents/subagent-done.ts";

const handlers = new Map<string, Function>();
const idle = setInterval(() => {}, 60_000);
const ctx = {
  ui: { setWidget() {} },
  shutdown() { clearInterval(idle); },
};
subagentDone({
  on(event: string, handler: Function) { handlers.set(event, handler); },
  getAllTools() { return []; },
  appendEntry(customType: string, data: unknown) {
    appendFileSync(process.env.PI_SUBAGENT_SESSION!, JSON.stringify({ type: "custom", customType, data }) + "\n");
  },
  registerTool() {},
  registerCommand() {},
  registerShortcut() {},
} as any);

const message = {
  role: "assistant",
  stopReason: process.env.PI_TEST_STOP_REASON ?? "stop",
  errorMessage: process.env.PI_TEST_STOP_REASON === "error" ? "529 overloaded" : undefined,
  content: [{ type: "text", text: "Brief demo finished." }],
};
writeFileSync(process.env.PI_SUBAGENT_SESSION!, [
  { type: "session", version: 3, id: "test-child", cwd: process.cwd() },
  { type: "message", id: "answer", parentId: null, message },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
for (const event of ["session_start", "before_agent_start", "agent_start"]) {
  handlers.get(event)?.({ type: event }, ctx);
}
handlers.get("agent_end")?.({ type: "agent_end", messages: [message] }, ctx);
console.log("__DEMO_TURN_FINISHED__");
