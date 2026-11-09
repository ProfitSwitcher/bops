/**
 * A computer task in local mode: screenshot, ask the vision model, act on the native worker.
 * The OpenAI Agents API is not called.
 */
import { localOrgoCall } from "./orgo-adapter";
import { loadConfig, localOnly } from "./mode";
import { ACTION_TYPES, runComputerUseLoop, type ComputerAction } from "./computer-use";

type Worker = { id: string; url: string; token?: string };

function worker(): Worker {
  const list = loadConfig().workers;
  return list[0] ?? { id: "studio3", url: "http://127.0.0.1:8791", token: process.env.BOPS_LOCAL_WORKER_TOKEN || "" };
}

function headers(w: Worker) {
  return { "Content-Type": "application/json", ...(w.token ? { Authorization: `Bearer ${w.token}` } : {}) };
}

/** Where a screen reset would write a shell script. Local mode writes nothing. */
export function screenResetPlan(local = localOnly()): { shell: string | null } {
  return { shell: local ? null : "/usr/local/bin/bops-reset-screen" };
}

const ACTION_ALIASES: Record<string, (typeof ACTION_TYPES)[number]> = {
  click: "click",
  left_click: "click",
  leftclick: "click",
  mouse_click: "click",
  right_click: "click",
  rightclick: "click",
  double_click: "double_click",
  doubleclick: "double_click",
  double: "double_click",
  move: "move",
  mouse_move: "move",
  mousemove: "move",
  move_mouse: "move",
  movemouse: "move",
  pointer_move: "move",
  type: "type",
  type_text: "type",
  typetext: "type",
  write: "type",
  key: "key",
  keypress: "key",
  key_press: "key",
  hotkey: "key",
  press_key: "key",
  scroll: "scroll",
  drag: "drag",
  wait: "wait",
  screenshot: "screenshot",
};

/** Map a model's action name onto a worker action. Unknown names are an error, not a silent no-op. */
export function normalizeAction(action: ComputerAction): { action: ComputerAction } | { error: string } {
  const raw = String(action.type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const type = ACTION_ALIASES[raw];
  if (!type) return { error: `Unknown action "${action.type || ""}". Allowed: ${ACTION_TYPES.join(", ")}.` };
  const button = raw === "right_click" || raw === "rightclick" ? "right" : action.button;
  return { action: { ...action, type, button } };
}

/** One action as a worker request. Screenshot and wait are not sent to the worker. */
export function workerAction(action: ComputerAction): { path: string; body: Record<string, unknown> } | { error: string } | null {
  const normalized = normalizeAction(action);
  if ("error" in normalized) return normalized;
  const next = normalized.action;
  if (next.type === "wait" || next.type === "screenshot") return null;
  if (next.type === "click" || next.type === "double_click") return { path: "/click", body: { x: next.x, y: next.y, double: next.type === "double_click", button: next.button } };
  if (next.type === "type") return { path: "/type", body: { text: next.text ?? "" } };
  if (next.type === "key") return { path: "/key", body: { keys: next.keys ?? [], key: (next.keys ?? []).join("+") } };
  if (next.type === "scroll") return { path: "/scroll", body: { x: next.x, y: next.y, scroll_x: next.scroll_x, scroll_y: next.scroll_y } };
  if (next.type === "move") return { path: "/move", body: { x: next.x, y: next.y } };
  if (next.type === "drag") {
    const last = next.path?.at(-1);
    return last ? { path: "/move", body: { x: last.x, y: last.y } } : { error: `Unknown action "drag" without a path. Allowed: ${ACTION_TYPES.join(", ")}.` };
  }
  return { error: `Unknown action "${action.type}". Allowed: ${ACTION_TYPES.join(", ")}.` };
}

/** A thread step for one worker action, in the same words the screen tools use. */
export function actionStep(action: ComputerAction): { tool: string; detail: string } {
  const normalized = normalizeAction(action);
  const next = "error" in normalized ? action : normalized.action;
  const at = `(${Math.round(Number(next.x) || 0)}, ${Math.round(Number(next.y) || 0)})`;
  switch (next.type) {
    case "click":
    case "double_click":
      return { tool: "click", detail: next.type === "double_click" ? `double-clicked ${at}` : `clicked ${at}` };
    case "type":
      return { tool: "type_text", detail: `typed "${(action.text ?? "").slice(0, 60)}"` };
    case "keypress":
    case "key":
      return { tool: "key", detail: `pressed ${(action.keys ?? []).join("+")}` };
    case "scroll":
      return { tool: "scroll", detail: "scrolled" };
    case "move":
    case "drag":
      return { tool: "move", detail: `moved the pointer ${at}` };
    default:
      return { tool: "note", detail: `could not run ${action.type || "that action"}` };
  }
}

/** Run one action on the computer id the bot already has. No xdotool and no /root file. */
export async function actOnLocalComputer(computerId: string, action: ComputerAction): Promise<void> {
  const req = workerAction(action);
  if (!req) return;
  if ("error" in req) throw new Error(req.error);
  await localOrgoCall("POST", `/computers/${encodeURIComponent(computerId)}${req.path}`, req.body);
}

export const SCREEN_LOCKED = "This Mac's screen is locked; unlock it to run screen tasks.";

export async function localComputerTurn(sessionId: string, goal: string, fetchImpl: typeof fetch = fetch, onStep?: (action: ComputerAction) => void): Promise<string> {
  const w = worker();
  const health = await fetchImpl(`${w.url}/health`, { signal: AbortSignal.timeout(3_000) }).then(async (r) => (r.ok ? ((await r.json()) as { locked?: boolean; lock?: string }) : null)).catch(() => null);
  if (health?.lock === "unknown") console.warn("[computer] screen lock check unknown");
  if (health?.locked) return SCREEN_LOCKED;
  const made = await fetchImpl(`${w.url}/v1/sessions`, { method: "POST", headers: headers(w), body: JSON.stringify({ name: sessionId }), signal: AbortSignal.timeout(15_000) });
  if (!made.ok) throw new Error(`The local worker did not open a session (${made.status}).`);
  const session = (await made.json()) as { id: string };
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${w.url}/v1/sessions/${session.id}${path}`, { method: "POST", headers: headers(w), body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(await res.text());
  };
  const result = await runComputerUseLoop({
    goal,
    screenshot: async () => {
      const res = await fetchImpl(`${w.url}/v1/sessions/${session.id}/screenshot`, { headers: headers(w), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return { mime: res.headers.get("content-type") || "image/png", base64: bytes.toString("base64") };
    },
    act: async (actions) => {
      const notes: string[] = [];
      for (const action of actions) {
        const req = workerAction(action);
        if (req && "error" in req) notes.push(req.error);
        else if (req) {
          await post(req.path, req.body);
          const normalized = normalizeAction(action);
          if ("action" in normalized) onStep?.(normalized.action);
        }
      }
      if (notes.length) return notes.join(" ");
      return actions.map((a) => a.type).join(", ") || "looked";
    },
    fetchImpl,
  });
  await fetchImpl(`${w.url}/v1/sessions/${session.id}`, { method: "DELETE", headers: headers(w) }).catch(() => {});
  return result.text;
}

