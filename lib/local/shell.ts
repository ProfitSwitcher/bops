/**
 * Shell commands on this Mac, through the local worker's /bash.
 * The working directory is a folder per bot under ~/bops/.data/workspaces.
 * Destructive commands are named here so the chat can ask before they run.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./mode";

export const SHELL_OUTPUT_CAP = 8_000;
export const SHELL_TIMEOUT_MS = 30_000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function botWorkspace(botId: string, home = homedir()): string {
  const safe = botId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "bot";
  return join(home, "bops", ".data", "workspaces", safe);
}

export function capOutput(text: string, cap = SHELL_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… truncated, ${text.length - cap} more characters`;
}

function outsideHome(path: string, home: string): boolean {
  if (path.startsWith("/tmp/") || path === "/tmp" || path.startsWith("/private/tmp") || path.startsWith("/var/folders")) return false;
  if (home && (path === home || path.startsWith(`${home}/`))) return false;
  return path.startsWith("/");
}

/** Why a command must wait for the user. Null when it can run as asked. */
export function commandNeedsApproval(command: string, home = homedir()): string | null {
  const c = command.trim();
  if (!c) return null;
  if (/\bsudo\b/.test(c)) return "uses sudo";
  if (/\brm\s+(-\S*r\S*|-[^\s]*f[^\s]*\s+-[^\s]*r|-[^\s]*r[^\s]*\s+-[^\s]*f)\b/.test(c) || /\brm\s+-rf\b/.test(c) || /\brm\s+--recursive\b/.test(c)) return "deletes files recursively";
  if (/\bgit\s+push\b[\s\S]*--force\b/.test(c) || /\bgit\s+push\s+-f\b/.test(c) || /\bgit\s+push\b[\s\S]*(?:^|\s)-f(?:\s|$)/.test(c)) return "force-pushes";
  if (/\b(shutdown|reboot|halt|mkfs|diskutil\s+erase)\b/.test(c)) return "changes the whole machine";
  if (/\b(pkill|killall|kill)\b[\s\S]{0,80}\b(bops|node|next)\b/i.test(c)) return "would stop Bops";
  if (/\blaunchctl\b[\s\S]*\b(bootout|unload|remove)\b/i.test(c) && /bops/i.test(c)) return "would stop Bops";
  const redirects = [...c.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(\/[^\s;&|]+)/g)].map((m) => m[1]);
  if (redirects.some((p) => outsideHome(p, home))) return "writes outside your home folder";
  const copy = c.match(/\b(?:cp|mv)\b([^\n]*)/);
  if (copy) {
    const paths = [...copy[1].matchAll(/(?:^|\s)(\/[^\s;&|]+)/g)].map((m) => m[1]);
    const dest = paths.at(-1);
    if (dest && outsideHome(dest, home)) return "writes outside your home folder";
  }
  return null;
}

type Worker = { id: string; url: string; token?: string };

function worker(): Worker {
  const list = loadConfig().workers;
  // Commands run on the machine hosting Bops. A worker on another host is not used for the shell.
  const here = list.find((w) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(w.url));
  return here ?? { id: "studio3", url: "http://127.0.0.1:8791", token: process.env.BOPS_LOCAL_WORKER_TOKEN || "" };
}

export type ShellResult = { exitCode: number; output: string; cwd: string };

/** Run one command on the local worker. Creates the workspace folder first. */
export async function runLocalShell(opts: { command: string; botId: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<ShellResult> {
  const command = opts.command.trim();
  const cwd = botWorkspace(opts.botId);
  mkdirSync(cwd, { recursive: true });
  const timeoutMs = Math.min(120_000, Math.max(1_000, opts.timeoutMs ?? SHELL_TIMEOUT_MS));
  console.log(`[shell] ${opts.botId} cwd=${cwd} ${command.slice(0, 300)}`);
  if (!command) return { exitCode: 1, output: "No command was given.", cwd };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const w = worker();
  const headers = { "Content-Type": "application/json", ...(w.token ? { Authorization: `Bearer ${w.token}` } : {}) };
  const session = "shell-session";
  const opened = await fetchImpl(`${w.url}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: session, name: "shell" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!opened.ok) throw new Error(`The local worker did not open a shell session (${opened.status}).`);
  const made = (await opened.json()) as { id?: string };
  const id = made.id || session;
  const script = `cd ${shellQuote(cwd)} && ${command}`;
  const res = await fetchImpl(`${w.url}/v1/sessions/${encodeURIComponent(id)}/bash`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command: script, cwd, timeout_ms: timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 300) || `The local worker returned ${res.status}.`);
  const body = (await res.json()) as { output?: string; exit_code?: number };
  return { exitCode: body.exit_code ?? 1, output: capOutput(body.output ?? ""), cwd };
}
