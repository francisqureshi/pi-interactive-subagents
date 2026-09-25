import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchZmxSession } from "../pi-extension/subagents/zmx-navigation.ts";
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
const previousDir = process.env.ZMX_DIR;
const previousSession = process.env.ZMX_SESSION;
const testDir = mkdtempSync(join(tmpdir(), "pi-subagent-zmx-test-"));
process.env.ZMX_DIR = testDir;
const surfaces: string[] = [];

after(() => {
  for (const surface of surfaces) {
    try { closeSurface(surface); } catch {}
  }
  if (previous === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = previous;
  if (previousPrefix === undefined) delete process.env.ZMX_SESSION_PREFIX;
  else process.env.ZMX_SESSION_PREFIX = previousPrefix;
  if (previousDir === undefined) delete process.env.ZMX_DIR;
  else process.env.ZMX_DIR = previousDir;
  if (previousSession === undefined) delete process.env.ZMX_SESSION;
  else process.env.ZMX_SESSION = previousSession;
  rmSync(testDir, { recursive: true, force: true });
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

test("zmx: launch stays non-blocking and the child reads interactive PTY input", { skip: !installed }, async () => {
  const help = execFileSync("zmx", ["help"], { encoding: "utf8" });
  if (!/^\s*\[s\]end\s/m.test(help)) return;
  process.env.PI_SUBAGENT_MUX = "zmx";
  const surface = createSurface("Interactive test");
  surfaces.push(surface);
  sendLongCommand(surface, "echo __AWAIT_INPUT__; read -r answer || exit 5; echo \"got:$answer\"; echo __SUBAGENT_DONE_0__");

  const deadline = Date.now() + 5_000;
  while (!readScreen(surface).includes("__AWAIT_INPUT__") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(readScreen(surface), /__AWAIT_INPUT__/);
  execFileSync("zmx", ["send", surface, "ready\r"], {
    stdio: "ignore", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
  });
  const result = await pollForExit(surface, AbortSignal.timeout(5_000), { interval: 100 });
  assert.equal(result.exitCode, 0);
  assert.match(readScreen(surface), /got:ready/);
});

test("zmx: split API creates a separate attachable session", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const surface = createSurfaceSplit("Second agent", "right");
  surfaces.push(surface);
  assert.match(surface, /^pi-subagent-/);
});

test("zmx: switching refuses missing sessions rather than creating them", { skip: !installed }, () => {
  process.env.ZMX_SESSION = "test-parent";
  assert.throws(() => switchZmxSession("not-running"), /has ended/);
  const sessions = execFileSync("zmx", ["list", "--short"], {
    encoding: "utf8", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
  });
  assert.ok(!sessions.split("\n").includes("not-running"));
});

test("zmx: older releases reject interrupt rather than sending Escape to a shell", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const help = execFileSync("zmx", ["help"], { encoding: "utf8" });
  if (/^\s*\[s\]end\s/m.test(help)) return; // newer versions support raw PTY input
  assert.throws(() => sendEscape("missing-session"), /requires zmx with the `send` command/);
});
