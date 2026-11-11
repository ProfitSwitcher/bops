/**
 * One picture of this Mac's screen, from the local worker. Shared by every bot.
 * It is not a per-bot VNC display.
 */
import { loadConfig } from "./mode";

const SESSION = "studio-screen";

function worker() {
  const list = loadConfig().workers;
  const here = list.find((w) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(w.url));
  return here ?? { id: "studio3", url: "http://127.0.0.1:8791", token: process.env.BOPS_LOCAL_WORKER_TOKEN || "" };
}

export const STUDIO_SCREEN_LABEL = "Studio 3 screen";

/** PNG bytes of the Mac the worker is running on. */
export async function workerScreenPng(fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const w = worker();
  const headers = { "Content-Type": "application/json", ...(w.token ? { Authorization: `Bearer ${w.token}` } : {}) };
  const opened = await fetchImpl(`${w.url}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: SESSION, name: STUDIO_SCREEN_LABEL }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!opened.ok) throw new Error(`The local worker did not open a screen session (${opened.status}).`);
  const made = (await opened.json()) as { id?: string };
  const id = made.id || SESSION;
  const shot = await fetchImpl(`${w.url}/v1/sessions/${encodeURIComponent(id)}/screenshot`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!shot.ok) throw new Error(`The local worker did not return a screenshot (${shot.status}).`);
  return Buffer.from(await shot.arrayBuffer());
}
