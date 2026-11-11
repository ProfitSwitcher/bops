/**
 * The Orgo REST calls the app already makes, answered by local workers.
 * A worker that is down is skipped. Nothing here calls orgo.ai.
 */
import { assertLocalHost } from "./egress.mjs";
import { localOnly, loadConfig } from "./mode";

type Worker = { id: string; url: string; token?: string };

const sessions = new Map<string, { worker: string; remote: string; name: string }>();

/** The four displays a Bops computer is expected to have. Matches lib/types DISPLAYS. */
const LOCAL_DISPLAYS = [100, 101, 102, 99];

export type LocalScreen = { id: string; display: string; width: number; height: number; vnc_port: number; ws_port: number; label: string };

const extraScreens: LocalScreen[] = [];

export function localScreens(): LocalScreen[] {
  return [
    ...LOCAL_DISPLAYS.map((display, i) => ({ id: `s${display}`, display: `:${display}`, width: 1280, height: 960, vnc_port: 5900 + i, ws_port: 6080 + i, label: "Studio 3 screen (shared, not a separate VNC display)" })),
    ...extraScreens,
  ];
}

function addLocalScreen(): LocalScreen {
  const n = 103 + extraScreens.length;
  const screen = { id: `s${n}`, display: `:${n}`, width: 1280, height: 960, vnc_port: 5910 + extraScreens.length, ws_port: 6090 + extraScreens.length, label: "Studio 3 screen (shared, not a separate VNC display)" };
  extraScreens.push(screen);
  return screen;
}

export function resetLocalComputersForTests() {
  extraScreens.length = 0;
  sessions.clear();
}

/** Whether another createScreen call grew the list. A list that stays the same must stop the loop. */
export function screensAdvanced<T extends { display?: string }>(before: readonly T[], after: readonly T[], display: number): "ready" | "grew" | "stuck" {
  if (after.some((s) => s.display === `:${display}`)) return "ready";
  if (after.length <= before.length) return "stuck";
  return "grew";
}

export function localComputersOn() {
  return localOnly() && process.env.BOPS_COMPUTER_BACKEND !== "orgo";
}

function workers(): Worker[] {
  const list = loadConfig().workers;
  return list.length ? list : [{ id: "studio3", url: "http://127.0.0.1:8791", token: process.env.BOPS_LOCAL_WORKER_TOKEN || "" }];
}

function headers(worker: Worker) {
  return { "Content-Type": "application/json", ...(worker.token ? { Authorization: `Bearer ${worker.token}` } : {}) };
}

async function healthy(worker: Worker): Promise<boolean> {
  try {
    const url = new URL(worker.url);
    assertLocalHost(url.hostname);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1" && !worker.token) return false;
    const res = await fetch(`${worker.url}/health`, { headers: headers(worker), signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function firstWorker(): Promise<Worker> {
  const skipped: string[] = [];
  for (const worker of workers()) {
    if (await healthy(worker)) return worker;
    skipped.push(worker.id);
  }
  throw new Error(`No local computer worker is up (${skipped.join(", ") || "none configured"}). Start one with node workers/bops-local-worker.mjs. Orgo cloud computers are not used.`);
}

/** The error healIfGone treats as a computer that is gone, so the UI can recover. */
export function localComputerMissing(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No local worker has computer ");
}

function missing(computerId: string): Error {
  return new Error(`No local worker has computer ${computerId}.`);
}

/** `local_<workerId>_<sessionId>`. The longest configured worker id wins, so an id may contain underscores. */
function parseLocalComputer(computerId: string): { worker: Worker; remote: string } | null {
  const list = [...workers()].sort((a, b) => b.id.length - a.id.length);
  for (const worker of list) {
    const prefix = `local_${worker.id}_`;
    if (!computerId.startsWith(prefix)) continue;
    const remote = computerId.slice(prefix.length);
    if (remote && /^[A-Za-z0-9-]{8,80}$/.test(remote)) return { worker, remote };
  }
  return null;
}

/**
 * The computer id outlives this process. When it isn't in the map, open that same session on the worker again.
 * A worker that restarted accepts the id and creates it.
 */
async function ensureComputer(computerId: string): Promise<{ worker: Worker; remote: string }> {
  const known = sessions.get(computerId);
  const parsed = parseLocalComputer(computerId);
  const worker = (known && workers().find((w) => w.id === known.worker)) || parsed?.worker;
  const remote = known?.remote || parsed?.remote;
  if (!worker || !remote) throw missing(computerId);
  // A worker that just started can reset the first connection. Try again before giving up.
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${worker.url}/v1/sessions`, {
        method: "POST",
        headers: headers(worker),
        body: JSON.stringify({ id: remote, name: known?.name || "Local computer" }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        sessions.set(computerId, { worker: worker.id, remote, name: known?.name || "Local computer" });
        return { worker, remote };
      }
      last = new Error(await res.text());
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (localComputerMissing(last)) throw last;
  const cause = last instanceof Error && "cause" in last ? ` (${(last.cause as Error)?.message || last.cause})` : "";
  const why = last instanceof Error ? last.message : String(last ?? "no answer");
  throw new Error(`No local worker has computer ${computerId}. ${why}${cause}`);
}

export async function localOrgoCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (process.env.BOPS_COMPUTER_BACKEND === "orgo") throw new Error("Local-only mode refuses Orgo cloud computers. Leave BOPS_COMPUTER_BACKEND unset.");
  const url = new URL(path, "http://local.invalid");
  const name = url.pathname;
  if (/\/(deploy|domains|dns|hosting)/.test(name)) throw new Error("Publishing to the web is unavailable offline.");
  if (method === "GET" && name === "/workspaces") return workspaceList() as T;
  if (method === "POST" && name === "/workspaces") return { id: "local", name: "bops", product: "bops", bops_ws_id: "ws_main" } as T;
  if (method === "GET" && name.startsWith("/workspaces/")) return { desktops: [...sessions.values()].map((s, i) => ({ id: [...sessions.keys()][i], name: s.name })) } as T;
  if (method === "PATCH" && name.startsWith("/workspaces/")) return { ...(body as object), product: "bops" } as T;
  if (method === "POST" && name === "/computers") return createComputer(body) as T;
  const computer = name.match(/^\/computers\/([^/]+)(.*)$/);
  if (!computer) throw new Error(`Local computers don't support ${method} ${name}.`);
  const id = decodeURIComponent(computer[1]);
  const rest = computer[2] || "";
  if (method === "GET" && rest === "") return computerInfo(id) as T;
  if (method === "DELETE" && rest === "") return removeComputer(id) as T;
  if (method === "GET" && rest === "/screens") return { screens: localScreens() } as T;
  if (method === "POST" && rest === "/screens") return addLocalScreen() as T;
  if (method === "GET" && rest === "/resize") return { current_disk_gb: 80, max_disk_gb: 80 } as T;
  if (method === "POST" && rest === "/resume") return { waking: false } as T;
  if (method === "POST" && (rest === "/restart" || rest === "/webrtc")) return { webrtc: false } as T;
  if (method === "POST" && (rest === "/bash" || rest === "/click" || rest === "/type" || rest === "/key" || rest === "/scroll" || rest === "/move")) return forward(id, rest, body) as T;
  return {} as T;
}

async function workspaceList() {
  return { workspaces: [{ id: "local", name: "bops", role: "owner", product: "bops", bops_ws_id: "ws_main", desktops: [...sessions.entries()].map(([id, s]) => ({ id, name: s.name })) }] };
}

async function createComputer(body: unknown) {
  const worker = await firstWorker();
  const name = String((body as { name?: string } | undefined)?.name || "Bops computer");
  const res = await fetch(`${worker.url}/v1/sessions`, { method: "POST", headers: headers(worker), body: JSON.stringify({ name }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(await res.text());
  const made = (await res.json()) as { id: string; name?: string; status?: string };
  const id = `local_${worker.id}_${made.id}`;
  sessions.set(id, { worker: worker.id, remote: made.id, name: made.name || name });
  return { id, name: made.name || name, status: made.status || "running" };
}

async function computerInfo(id: string) {
  const { remote } = await ensureComputer(id);
  const known = sessions.get(id);
  return {
    id,
    name: known?.name ?? "Local computer",
    status: "running",
    cpu: 4,
    ram: 8,
    os: "local",
    vnc_password: "local",
    instance_details: { id: remote, webrtc: false },
    project_id: "local",
    workspace_id: "local",
  };
}

async function removeComputer(id: string) {
  const known = sessions.get(id);
  const parsed = parseLocalComputer(id);
  const worker = (known && workers().find((w) => w.id === known.worker)) || parsed?.worker;
  const remote = known?.remote || parsed?.remote;
  sessions.delete(id);
  if (worker && remote) await fetch(`${worker.url}/v1/sessions/${encodeURIComponent(remote)}`, { method: "DELETE", headers: headers(worker) }).catch(() => {});
  return { ok: true };
}

async function forward(id: string, path: string, body: unknown) {
  const { worker, remote } = await ensureComputer(id);
  const res = await fetch(`${worker.url}/v1/sessions/${remote}${path}`, { method: "POST", headers: headers(worker), body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function localOrgoAnswered(url: string, _init: RequestInit, _timeoutMs: number, signal: AbortSignal | undefined, read: (res: Response) => Promise<unknown>) {
  const u = new URL(url, "http://local.invalid");
  const shot = u.pathname.match(/\/computers\/([^/]+)\/screenshot$/);
  if (!shot) {
    const res = new Response(JSON.stringify({ error: "That computer call isn't available offline." }), { status: 404 });
    return { res, text: await read(res), key: "local" };
  }
  const id = decodeURIComponent(shot[1]);
  const { worker, remote } = await ensureComputer(id);
  const res = await fetch(`${worker.url}/v1/sessions/${remote}/screenshot${u.search}`, { headers: headers(worker), signal });
  return { res, text: await read(res), key: "local" };
}
