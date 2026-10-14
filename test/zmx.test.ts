import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ as subagents } from "../pi-extension/subagents/index.ts";
import { switchZmxSession } from "../pi-extension/subagents/zmx-navigation.ts";
import {
  createSurface,
  createSurfaceSplit,
  sendLongCommand,
  sendCommand,
  readScreen,
  readScreenAsync,
  pollForExit,
  closeSurface,
  getMuxBackend,
  renameCurrentTab,
  renameWorkspace,
  sendEscape,
  shellEscape,
} from "../pi-extension/subagents/cmux.ts";

const installed = spawnSync("zmx", ["version"], { stdio: "ignore" }).status === 0;
const previous = process.env.PI_SUBAGENT_MUX;
const previousPrefix = process.env.ZMX_SESSION_PREFIX;
const previousDir = process.env.ZMX_DIR;
const previousSession = process.env.ZMX_SESSION;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testDir = mkdtempSync(join(tmpdir(), "pi-subagent-zmx-test-"));
process.env.ZMX_DIR = testDir;
process.env.PI_CODING_AGENT_DIR = testDir;
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
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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

async function exerciseScriptedSubagent(options: {
  params?: Partial<Parameters<typeof subagents.launchSubagent>[0]>;
  frontmatter?: string;
  stopReason?: "stop" | "aborted" | "error";
  staysOpen?: boolean;
  kill?: boolean;
  untrackBeforeAbort?: boolean;
} = {}) {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const surface = createSurface("Brief demo");
  surfaces.push(surface);
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-demo-test-"));
  const abort = new AbortController();
  let running: Awaited<ReturnType<typeof subagents.launchSubagent>> | undefined;
  let watcher: ReturnType<typeof subagents.watchSubagent> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Use the real launch script, child extension and parent watcher, but a
    // scripted CLI response instead of a slow/non-deterministic model request.
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const fixture = fileURLToPath(new URL("./fixtures/subagent-cli.ts", import.meta.url));
    writeFileSync(join(binDir, "pi"), `#!/usr/bin/env bash\nPI_TEST_STOP_REASON=${shellEscape(options.stopReason ?? "stop")} exec ${shellEscape(process.execPath)} ${shellEscape(fixture)}\n`, { mode: 0o755 });
    // Children must set both policies explicitly, not inherit the opposite
    // policy from their parent (including when the parent's flag is zero).
    sendCommand(surface, `export PATH=${shellEscape(binDir)}:$PATH PI_SUBAGENT_AUTO_EXIT=${options.staysOpen ? "1" : "0"}; echo __FAKE_CLI_READY__`);
    const deadline = Date.now() + 5_000;
    while (!readScreen(surface).includes("__FAKE_CLI_READY__") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(readScreen(surface), /__FAKE_CLI_READY__/);

    if (options.frontmatter !== undefined) {
      const agentsDir = join(testDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "test-demo.md"), `---\nname: test-demo\n${options.frontmatter}\n---\n`);
    }
    writeFileSync(join(dir, "parent.jsonl"), JSON.stringify({
      type: "session", version: 3, id: "test-parent", timestamp: new Date().toISOString(), cwd: dir,
    }) + "\n");
    running = await subagents.launchSubagent({ name: "Brief demo", task: "Keep the demo brief.", cwd: dir, ...options.params }, {
      cwd: dir,
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "test-parent",
        getSessionDir: () => dir,
      },
    }, { surface });
    const finishedDeadline = Date.now() + 2_000;
    while (!readScreen(surface).includes("__DEMO_TURN_FINISHED__") && Date.now() < finishedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(readScreen(surface, 25), /__DEMO_TURN_FINISHED__/, "scripted CLI should emit agent_end");
    assert.ok(readFileSync(running.sessionFile, "utf8").includes("Brief demo finished."), "the child must have actually finished its turn");
    const activity = JSON.parse(readFileSync(running.activityFile!, "utf8"));
    assert.equal(activity.latestEvent, "agent_end");
    running.abortController = abort;
    watcher = subagents.watchSubagent(running, abort.signal);
    if (options.staysOpen) {
      let settled = false;
      watcher.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(settled, false, "interrupts and opt-outs must leave the watcher alive");
      assert.equal(activity.phase, "waiting");
      assert.equal(existsSync(running.sessionFile + ".exit"), false);
      assert.equal(subagents.runningSubagents.has(running.id), true);
      if (options.untrackBeforeAbort) {
        // session_shutdown clears the map immediately after aborting watchers.
        subagents.runningSubagents.delete(running.id);
        abort.abort();
        await watcher;
        assert.ok(!execFileSync("zmx", ["list", "--short"], {
          encoding: "utf8", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
        }).split("\n").includes(surface), "shutdown must close children even after clearing the map");
      }
      if (options.kill) {
        const result = subagents.killSubagent(running.id);
        assert.ok(!("error" in result), "management termination should close the child");
        const completion = await watcher;
        assert.equal(completion.error, "cancelled");
        assert.equal(subagents.runningSubagents.has(running.id), false);
        assert.equal(existsSync(running.sessionFile), true, "killing must keep session history");
        assert.ok(!execFileSync("zmx", ["list", "--short"], {
          encoding: "utf8", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
        }).split("\n").includes(surface));
      }
      return;
    }
    timeout = setTimeout(() => abort.abort(), 3_000);
    const result = await watcher;
    clearTimeout(timeout);
    assert.equal(result.exitCode, options.stopReason === "error" ? 1 : 0, "a completed turn must not stay idle until the watcher is cancelled");
    assert.equal(result.error, undefined, "completion should come from the child, not watcher cancellation");
    assert.equal(result.summary, "Brief demo finished.");
    if (options.stopReason === "error") assert.equal(result.errorMessage, "529 overloaded");
    assert.equal(subagents.runningSubagents.has(running.id), false);
    assert.ok(!execFileSync("zmx", ["list", "--short"], {
      encoding: "utf8", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
    }).split("\n").includes(surface), "completed child surface should be closed");
  } finally {
    clearTimeout(timeout);
    abort.abort();
    if (watcher) await watcher;
    if (!running?.surfaceClosed) { try { closeSurface(surface); } catch {} }
    surfaces.pop();
    rmSync(join(testDir, "agents", "test-demo.md"), { force: true });
    if (running) {
      subagents.runningSubagents.delete(running.id);
      for (const file of [running.sessionFile, running.sessionFile + ".exit"]) rmSync(file, { force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("zmx: a bare subagent completes and leaves the running list without calling subagent_done", { skip: !installed }, async () => {
  await exerciseScriptedSubagent();
});

test("zmx: named task agents without an auto-exit setting also close", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ params: { agent: "test-demo" }, frontmatter: "description: Test task" });
});

test("zmx: tool and agent opt-outs override an inherited auto-exit flag", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ params: { autoExit: false }, staysOpen: true });
  await exerciseScriptedSubagent({ params: { agent: "test-demo" }, frontmatter: "auto-exit: false", staysOpen: true });
});

test("zmx: fork handoffs and aborted turns stay open", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ params: { fork: true }, staysOpen: true });
  await exerciseScriptedSubagent({ stopReason: "aborted", staysOpen: true });
});

test("zmx: auto-exit failures reach the parent with their error message", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ stopReason: "error" });
});

test("zmx: management termination closes the session, cancels its watcher, and keeps history", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ params: { autoExit: false }, staysOpen: true, kill: true });
});

test("zmx: parent shutdown closes children after clearing the running map", { skip: !installed }, async () => {
  await exerciseScriptedSubagent({ params: { autoExit: false }, staysOpen: true, untrackBeforeAbort: true });
});

test("zmx: split API creates a separate attachable session", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const surface = createSurfaceSplit("Second agent", "right");
  surfaces.push(surface);
  assert.match(surface, /^pi-subagent-/);
});

test("zmx: switching refuses missing sessions rather than creating them", { skip: !installed }, () => {
  const sshConnection = process.env.SSH_CONNECTION;
  delete process.env.SSH_CONNECTION;
  try {
    process.env.ZMX_SESSION = "test-parent";
    assert.throws(() => switchZmxSession("not-running"), /has ended/);
    const sessions = execFileSync("zmx", ["list", "--short"], {
      encoding: "utf8", env: { ...process.env, ZMX_SESSION_PREFIX: "" },
    });
    assert.ok(!sessions.split("\n").includes("not-running"));
  } finally {
    if (sshConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = sshConnection;
  }
});

test("zmx: refuses to switch a session without exactly one attached client", { skip: !installed }, () => {
  const sshConnection = process.env.SSH_CONNECTION;
  delete process.env.SSH_CONNECTION;
  const current = createSurface("Detached parent");
  const target = createSurface("Detached child");
  surfaces.push(current, target);
  try {
    process.env.ZMX_SESSION = current;
    assert.throws(() => switchZmxSession(target), /expected one attached client, found 0/);
  } finally {
    if (sshConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = sshConnection;
  }
});

test("zmx: refuses remote zmosh switches before contacting the session leader", () => {
  const sshConnection = process.env.SSH_CONNECTION;
  const sshTty = process.env.SSH_TTY;
  process.env.ZMX_SESSION = "remote-session";
  process.env.SSH_CONNECTION = "127.0.0.1 1234 127.0.0.1 22";
  delete process.env.SSH_TTY;
  try {
    assert.throws(() => switchZmxSession("child"), /remote zmosh attachment is not supported/);
  } finally {
    if (sshConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = sshConnection;
    if (sshTty === undefined) delete process.env.SSH_TTY;
    else process.env.SSH_TTY = sshTty;
  }
});

test("zmx: older releases reject interrupt rather than sending Escape to a shell", { skip: !installed }, () => {
  process.env.PI_SUBAGENT_MUX = "zmx";
  const help = execFileSync("zmx", ["help"], { encoding: "utf8" });
  if (/^\s*\[s\]end\s/m.test(help)) return; // newer versions support raw PTY input
  assert.throws(() => sendEscape("missing-session"), /requires zmx with the `send` command/);
});
