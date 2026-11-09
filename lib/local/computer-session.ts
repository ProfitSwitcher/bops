/**
 * A computer task in local mode: screenshot, ask the vision model, act on the native worker.
 * The OpenAI Agents API is not called.
 */
import { loadConfig } from "./mode";
import { runComputerUseLoop, type ComputerAction } from "./computer-use";

type Worker = { id: string; url: string; token?: string };

function worker(): Worker {
  const list = loadConfig().workers;
  return list[0] ?? { id: "studio3", url: "http://127.0.0.1:8791", token: process.env.BOPS_LOCAL_WORKER_TOKEN || "" };
}

function headers(w: Worker) {
  return { "Content-Type": "application/json", ...(w.token ? { Authorization: `Bearer ${w.token}` } : {}) };
}

export async function localComputerTurn(sessionId: string, goal: string, fetchImpl: typeof fetch = fetch): Promise<string> {
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
      for (const action of actions) await actOne(post, action);
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
