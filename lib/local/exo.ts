/**
 * exo (exo-labs) cluster state. GET /state is the only inventory we trust.
 * A model is eligible when at least one node has DownloadCompleted for it and
 * no node is still downloading it or has failed. exo can place a single-node
 * model on the machine that holds the weights (Kimi and Qwen3-Coder are often
 * complete on Studio 1 only). A partial download is never requested, so a chat
 * cannot start a Hugging Face fetch.
 */

export type ExoInventory = { downloaded: string[]; downloading: string[] };

export type ExoWarmup = { endpoint: string; model: string; since: number };

let warming: ExoWarmup | null = null;

export function exoWarmup(): ExoWarmup | null {
  return warming ? { ...warming } : null;
}

export function beginExoWarmup(endpoint: string, model: string) {
  warming = { endpoint, model, since: Date.now() };
}

export function endExoWarmup(endpoint: string, model: string) {
  if (warming?.endpoint === endpoint && warming.model === model) warming = null;
}

export function resetExoForTests() {
  warming = null;
}

/** Default wait for an already-downloaded exo model to load into memory. */
export function exoLoadTimeoutMs(): number {
  const n = Number(process.env.BOPS_EXO_LOAD_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : 10 * 60_000;
}

export function modelsFromExoState(body: unknown): ExoInventory {
  const done = new Map<string, number>();
  const busy = new Set<string>();
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const downloads = root.downloads;
  const groups = downloads && typeof downloads === "object" ? Object.values(downloads as Record<string, unknown>) : [];
  for (const group of groups) {
    const items = Array.isArray(group) ? group : group ? [group] : [];
    for (const item of items) {
      const found = classify(item);
      if (!found.id) continue;
      if (found.done) done.set(found.id, (done.get(found.id) ?? 0) + 1);
      else busy.add(found.id);
    }
  }
  const downloaded = [...done.keys()].filter((id) => !busy.has(id));
  return { downloaded, downloading: [...busy] };
}

function classify(item: unknown): { id?: string; done: boolean } {
  if (!item || typeof item !== "object") return { done: false };
  const rec = item as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!/^Download(Completed|Ongoing|Pending|Failed)$/.test(key)) continue;
    const inner = rec[key];
    if (!inner || typeof inner !== "object") continue;
    return { id: modelId(inner as Record<string, unknown>), done: key === "DownloadCompleted" };
  }
  const status = String(rec.status ?? rec.type ?? rec.kind ?? "");
  const id = modelId(rec);
  if (/fail|ongoing|pending|download|in_progress|incomplete/i.test(status)) return { id, done: false };
  if (/complete/i.test(status)) return { id, done: true };
  return { id, done: false };
}

function modelId(obj: Record<string, unknown>): string | undefined {
  const raw = (obj.shardMetadata ?? obj.shard_metadata) as Record<string, unknown> | undefined;
  const shard = raw && typeof raw === "object" ? unwrapVariant(raw) : undefined;
  const card = shard ? ((shard.modelCard ?? shard.model_card) as Record<string, unknown> | undefined) : undefined;
  const id = card?.modelId ?? card?.model_id ?? obj.modelId ?? obj.model_id ?? obj.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** exo tags shard metadata as one key, PipelineShardMetadata or TensorShardMetadata. */
function unwrapVariant(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length === 1 && /ShardMetadata$/.test(keys[0])) {
    const inner = obj[keys[0]];
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  }
  return obj;
}
