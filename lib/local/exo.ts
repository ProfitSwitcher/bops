/**
 * exo (exo-labs) cluster state. GET /state is the only inventory we trust.
 * A model is usable when every node that mentions it has DownloadCompleted.
 * DownloadOngoing, DownloadPending, and DownloadFailed are not usable, so a
 * chat request cannot start a Hugging Face download.
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
  const downloaded = new Set<string>();
  const downloading = new Set<string>();
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const downloads = root.downloads;
  const groups = downloads && typeof downloads === "object" ? Object.values(downloads as Record<string, unknown>) : [];
  for (const group of groups) {
    const items = Array.isArray(group) ? group : group ? [group] : [];
    for (const item of items) {
      const found = classify(item);
      if (!found.id) continue;
      if (found.done) downloaded.add(found.id);
      else downloading.add(found.id);
    }
  }
  for (const id of downloading) downloaded.delete(id);
  return { downloaded: [...downloaded], downloading: [...downloading] };
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
  const shard = (obj.shardMetadata ?? obj.shard_metadata) as Record<string, unknown> | undefined;
  const card = shard && typeof shard === "object" ? ((shard.modelCard ?? shard.model_card) as Record<string, unknown> | undefined) : undefined;
  const id = card?.modelId ?? card?.model_id ?? obj.modelId ?? obj.model_id ?? obj.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
