import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  createSurface,
  createSurfaceSplit,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  pollForExit,
  closeSurface,
  getMuxBackend,
  renameCurrentTab,
  renameWorkspace,
  sendEscape,
} from "../pi-extension/subagents/cmux.ts";

const installed = spawnSync("zmx", ["version"], { stdio: "ignore" }).status === 0;
const previous = process.env.PI_SUBAGENT_MUX;
const previousPrefix = process.env.ZMX_SESSION_PREFIX;
const surfaces: string[] = [];

after(() => {
  for (const surface of surfaces) {
    try { closeSurface(surface); } catch {}
  }
  if (previous === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = previous;
  if (previousPrefix === undefined) delete process.env.ZMX_SESSION_PREFIX;
  else process.env.ZMX_SESSION_PREFIX = previousPrefix;
});

test("zmx: detached sessions run scripts, expose history, and clean up", { skip: !installed }, async () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  process.env.ZMX_SESSION_PREFIX = "test-prefix-";
  assert.equal(getMuxBackend(), "zmx");

  const surface = createSurface("Test agent");
  surfaces.push(surface);
  assert.match(surface, /^pi-subagent-[a-z0-9-]+$/);
  const list = execFileSync("zmx", ["list", "--short"], {
    encoding: "utf8",
    env: { ...process.env, ZMX_SESSION_PREFIX: "" },
  });
  assert.ok(list.split("\n").includes(surface), "session should not inherit parent's prefix");

  // Renaming terminal tabs/workspaces is deliberately a no-op without a mux.
  renameCurrentTab("Test agent");
  renameWorkspace("Test workspace");

  sendLongCommand(surface, "printf 'headless session works\\n'; echo __SUBAGENT_DONE_0__");
  const result = await pollForExit(surface, AbortSignal.timeout(10_000), { interval: 100 });
  assert.equal(result.exitCode, 0);
  assert.match(readScreen(surface), /headless session works/);
  assert.match(await readScreenAsync(surface), /__SUBAGENT_DONE_0__/);

  closeSurface(surface);
  surfaces.pop();
  const remaining = execFileSync("zmx", ["list", "--short"], {
    encoding: "utf8",
    env: { ...process.env, ZMX_SESSION_PREFIX: "" },
  });
  assert.ok(!remaining.split("\n").includes(surface));
});

test("zmx: split API creates a separate attachable session", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const surface = createSurfaceSplit("Second agent", "right");
  surfaces.push(surface);
  assert.match(surface, /^pi-subagent-/);
});

test("zmx: older releases reject interrupt rather than sending Escape to a shell", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const help = execFileSync("zmx", ["help"], { encoding: "utf8" });
  if (/^\s*\[s\]end\s/m.test(help)) return; // newer versions support raw PTY input
  assert.throws(() => sendEscape("missing-session"), /requires zmx with the `send` command/);
});
