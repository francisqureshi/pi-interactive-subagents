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

/** `zmx attach` switches the leader client, not necessarily the caller's client. */
export function parseZmxClientCount(list: string, session: string): number | null {
  for (const line of list.split(/\r?\n/)) {
    const name = line.match(/(?:^|\s)name=([^\t]+)(?:\t|$)/)?.[1];
    if (name !== session) continue;
    const count = line.match(/(?:^|\t)clients=(\d+)(?:\t|$)/)?.[1];
    return count === undefined ? null : Number(count);
  }
  return null;
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
  // zmosh PR #271 bootstraps with `ssh -T`; its remote client cannot follow
  // zmx's in-session Switch message. Ordinary interactive SSH has SSH_TTY.
  if (process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
    throw new Error("Switching from a remote zmosh attachment is not supported. Reattach from your local terminal.");
  }

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
  const count = parseZmxClientCount(execFileSync("zmx", ["list"], {
    encoding: "utf8", env: zmxEnv(),
  }), current);
  if (count !== 1) {
    throw new Error(
      `Cannot safely switch ${current}: expected one attached client, found ${count ?? "unknown"}. ` +
      "Zmx switches the session leader, which could be someone else's terminal.",
    );
  }

  // zmx >=0.5 sends a switch request to the session's existing client and
  // returns immediately. No TUI suspension, nested client, or tmux is needed.
  // Ignore stdio so the child process cannot take over Pi's terminal renderer.
  execFileSync("zmx", ["attach", target], { stdio: "ignore", env: zmxEnv() });
}
