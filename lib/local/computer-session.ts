/**
 * A computer task in local mode: screenshot, ask the vision model, act on the native worker.
 * The OpenAI Agents API is not called.
 */
import { localOrgoCall } from "./orgo-adapter";
import { loadConfig, localOnly } from "./mode";
import { runComputerUseLoop, type ComputerAction } from "./computer-use";

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

/** One action as a worker request. Screenshot and wait are not shell commands. */
export function workerAction(action: ComputerAction): { path: string; body: Record<string, unknown> } | null {
  if (action.type === "click" || action.type === "double_click") return { path: "/click", body: { x: action.x, y: action.y, double: action.type === "double_click", button: action.button } };
  if (action.type === "type") return { path: "/type", body: { text: action.text ?? "" } };
  if (action.type === "keypress" || action.type === "key") return { path: "/key", body: { keys: action.keys ?? [], key: (action.keys ?? []).join("+") } };
  if (action.type === "scroll") return { path: "/scroll", body: { x: action.x, y: action.y, scroll_x: action.scroll_x, scroll_y: action.scroll_y } };
  if (action.type === "move") return { path: "/move", body: { x: action.x, y: action.y } };
  if (action.type === "drag") {
    const last = action.path?.at(-1);
    return last ? { path: "/move", body: { x: last.x, y: last.y } } : null;
  }
  return null;
}

/** A thread step for one worker action, in the same words the screen tools use. */
export function actionStep(action: ComputerAction): { tool: string; detail: string } {
  const at = `(${Math.round(Number(action.x) || 0)}, ${Math.round(Number(action.y) || 0)})`;
  switch (action.type) {
    case "click":
    case "double_click":
      return { tool: "click", detail: action.type === "double_click" ? `double-clicked ${at}` : `clicked ${at}` };
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
      return { tool: action.type || "screenshot", detail: "looked at the screen" };
  }
}

/** Run one action on the computer id the bot already has. No xdotool and no /root file. */
export async function actOnLocalComputer(computerId: string, action: ComputerAction): Promise<void> {
  const req = workerAction(action);
  if (!req) return;
  await localOrgoCall("POST", `/computers/${encodeURIComponent(computerId)}${req.path}`, req.body);
}

export async function localComputerTurn(sessionId: string, goal: string, fetchImpl: typeof fetch = fetch, onStep?: (action: ComputerAction) => void): Promise<string> {
  const w = worker();
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
      for (const action of actions) {
        await actOne(post, action);
        onStep?.(action);
      }
      return actions.map((a) => a.type).join(", ") || "looked";
    },
    fetchImpl,
  });
  await fetchImpl(`${w.url}/v1/sessions/${session.id}`, { method: "DELETE", headers: headers(w) }).catch(() => {});
  return result.text;
}

async function actOne(post: (path: string, body: unknown) => Promise<void>, action: ComputerAction) {
  if (action.type === "click" || action.type === "double_click") await post("/click", { x: action.x, y: action.y, double: action.type === "double_click" });
  else if (action.type === "type") await post("/type", { text: action.text ?? "" });
  else if (action.type === "keypress" || action.type === "key") await post("/key", { keys: action.keys ?? [], key: (action.keys ?? []).join("+") });
  else if (action.type === "scroll") await post("/scroll", { x: action.x, y: action.y, scroll_x: action.scroll_x, scroll_y: action.scroll_y });
  else if (action.type === "move") await post("/move", { x: action.x, y: action.y });
}
