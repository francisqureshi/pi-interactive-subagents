import { execFileSync } from "node:child_process";

/** The name of the session hosting this Pi process (not a session to create). */
export function currentZmxSession(): string | null {
  return process.env.ZMX_SESSION?.trim() || null;
}

/** Set by the parent when spawning a Pi child into its own zmx session. */
export function parentZmxSession(): string | null {
  return process.env.PI_SUBAGENT_PARENT_ZMX_SESSION?.trim() || null;
}

function zmxEnv(): NodeJS.ProcessEnv {
  // Surface names and ZMX_SESSION are already full names. An inherited prefix
  // would silently select/create a different session when passed to `attach`.
  return { ...process.env, ZMX_SESSION_PREFIX: "" };
}

export function parseZmxVersion(text: string): { major: number; minor: number } | null {
  const match = text.match(/^zmx\s+(\d+)\.(\d+)\./m);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/** Never call `attach` on a missing target: zmx would create a new empty session. */
export function switchZmxSession(target: string): void {
  const current = currentZmxSession();
  if (!current) {
    throw new Error(
      "Session switching requires Pi to run inside `zmx attach <parent>`. " +
      "Start a new Ghostty terminal to attach manually.",
    );
  }
  if (target === current) return;
  if (!target || /[\r\n]/.test(target)) throw new Error("Invalid zmx session name.");

  const versionText = execFileSync("zmx", ["version"], { encoding: "utf8" });
  const version = parseZmxVersion(versionText);
  if (!version || (version.major === 0 && version.minor < 5)) {
    throw new Error("Switching requires zmx 0.5.0 or newer; the installed zmx cannot switch nested sessions.");
  }

  const sessions = execFileSync("zmx", ["list", "--short"], {
    encoding: "utf8", env: zmxEnv(),
  }).split(/\r?\n/);
  if (!sessions.includes(target)) {
    throw new Error(`zmx session "${target}" has ended. Open the menu again to refresh the list.`);
  }

  // zmx >=0.5 sends a switch request to the session's existing client and
  // returns immediately. No TUI suspension, nested client, or tmux is needed.
  // Ignore stdio so the child process cannot take over Pi's terminal renderer.
  execFileSync("zmx", ["attach", target], { stdio: "ignore", env: zmxEnv() });
}
