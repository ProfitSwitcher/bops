/**
 * Optional Shared Brain (mcp-memory-service) on the tailnet.
 * Search is merged into local memory. Saves are explicit. A miss or a
 * refusal never blocks the chat.
 */
export type SharedHit = { content: string };

export function sharedBrainConfig(): { url: string; key: string; machine: string } | null {
  const url = process.env.BOPS_SHARED_BRAIN_URL?.trim().replace(/\/+$/, "") ?? "";
  const key = process.env.BOPS_SHARED_BRAIN_KEY?.trim() ?? "";
  if (!url || !key) return null;
  const machine = process.env.BOPS_SHARED_BRAIN_MACHINE?.trim() || "studio3";
  return { url, key, machine };
}

export function sharedBrainOn(): boolean {
  return sharedBrainConfig() !== null;
}

function headers(key: string) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function textOf(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const o = item as { content?: unknown; memory?: { content?: unknown }; text?: unknown };
  if (typeof o.content === "string") return o.content.trim();
  if (typeof o.text === "string") return o.text.trim();
  if (o.memory && typeof o.memory.content === "string") return o.memory.content.trim();
  return "";
}

/** Top hits from POST /api/search. Empty when Shared Brain is unset or down. */
export async function searchSharedBrain(query: string, limit = 3, fetchImpl: typeof fetch = fetch): Promise<SharedHit[]> {
  const cfg = sharedBrainConfig();
  const q = query.trim();
  if (!cfg || !q) return [];
  try {
    const res = await fetchImpl(`${cfg.url}/api/search`, {
      method: "POST",
      headers: headers(cfg.key),
      body: JSON.stringify({ query: q, n_results: limit }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { results?: unknown[]; memories?: unknown[] } | unknown[] | null;
    const list = Array.isArray(body) ? body : body && typeof body === "object" ? (body.results ?? body.memories ?? []) : [];
    const hits: SharedHit[] = [];
    for (const item of list) {
      const content = textOf(item);
      if (!content) continue;
      hits.push({ content: content.replace(/^shared memory:\s*/i, "") });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch {
    return [];
  }
}

/** POST /api/memories. False when it is unset or does not answer. */
export async function saveSharedBrain(content: string, botName: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const cfg = sharedBrainConfig();
  const text = content.trim();
  if (!cfg || !text) return false;
  const tags = ["bops", `bot:${botName.trim() || "bot"}`, `machine:${cfg.machine}`];
  try {
    const res = await fetchImpl(`${cfg.url}/api/memories`, {
      method: "POST",
      headers: headers(cfg.key),
      body: JSON.stringify({ content: text.slice(0, 2000), tags, memory_type: "note" }),
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
