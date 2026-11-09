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

/**
 * How exo places a model across the Thunderbolt pair, then on one node if tensor
 * placement is refused. exo's POST /place_instance takes these fields.
 */
export const EXO_PLACEMENTS = [
  { sharding: "Tensor", instance_meta: "MlxJaccl", min_nodes: 2 },
  { sharding: "Pipeline", instance_meta: "MlxRing", min_nodes: 1 },
] as const;

export type ExoInstance = { id: string; modelId: string; ready: boolean; failed?: string };

/** Running instances in GET /state. A runner is ready when it is RunnerReady or already RunnerRunning. */
export function exoInstances(body: unknown): ExoInstance[] {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const raw = root.instances && typeof root.instances === "object" ? (root.instances as Record<string, unknown>) : {};
  const runners = root.runners && typeof root.runners === "object" ? (root.runners as Record<string, unknown>) : {};
  const out: ExoInstance[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const inner = unwrapInstance(value);
    const shards = (inner.shardAssignments ?? inner.shard_assignments) as Record<string, unknown> | undefined;
    const modelId = String(shards?.modelId ?? shards?.model_id ?? inner.modelId ?? inner.model_id ?? "");
    const runnerMap = (shards?.runnerToShard ?? shards?.runner_to_shard) as Record<string, unknown> | undefined;
    const runnerIds = runnerMap ? Object.keys(runnerMap) : [];
    let ready = runnerIds.length > 0;
    let failed: string | undefined;
    for (const id of runnerIds) {
      const status = runnerStatus(runners[id]);
      if (status.failed) {
        failed = status.failed;
        ready = false;
      } else if (!status.ready) ready = false;
    }
    if (!modelId) continue;
    out.push({ id: String(inner.instanceId ?? inner.instance_id ?? key), modelId, ready, ...(failed ? { failed } : {}) });
  }
  return out;
}

export function exoInstanceFor(body: unknown, model: string): ExoInstance | undefined {
  const name = model.toLowerCase();
  const found = exoInstances(body).filter((i) => i.modelId.toLowerCase() === name);
  return found.find((i) => i.ready) ?? found[0];
}

function unwrapInstance(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 1 && /Instance$/.test(keys[0])) {
    const inner = rec[keys[0]];
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  }
  return rec;
}

function runnerStatus(runner: unknown): { ready: boolean; failed?: string } {
  if (!runner || typeof runner !== "object") return { ready: false };
  const rec = runner as Record<string, unknown>;
  const name = Object.keys(rec).find((k) => /^Runner/.test(k)) || String(rec.status ?? rec.type ?? "");
  if (name === "RunnerReady" || name === "RunnerRunning") return { ready: true };
  if (name === "RunnerFailed") {
    const inner = rec[name];
    const msg = inner && typeof inner === "object" ? (inner as Record<string, unknown>).errorMessage ?? (inner as Record<string, unknown>).error_message : undefined;
    return { ready: false, failed: typeof msg === "string" && msg.trim() ? msg : "runner failed" };
  }
  return { ready: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wontFit(detail: string): boolean {
  return /memory|no cycles|insufficient|not enough/i.test(detail);
}

async function stateOf(origin: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(`${origin}/state`, { headers, signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)) });
  if (!res.ok) throw new Error(`${res.status} from exo /state`);
  return res.json().catch(() => null);
}

async function errorText(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 500);
  try {
    const json = JSON.parse(text) as { detail?: unknown; error?: unknown };
    const detail = json.detail ?? json.error;
    return typeof detail === "string" ? detail : text;
  } catch {
    return text;
  }
}

/**
 * Chat returns 404 until exo has a running instance. Place one if this model has none.
 * A different model that is already running is left alone when it will not fit, unless
 * `allowEvict` is on. The caller still falls through to the next model when this throws.
 */
export async function ensureExoInstance(opts: {
  origin: string;
  model: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  allowEvict?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? exoLoadTimeoutMs();
  const headers = { ...opts.headers, Accept: "application/json" };
  const deadline = Date.now() + timeoutMs;
  const pause = () => sleep(timeoutMs < 5_000 ? 20 : 500);

  const waitReady = async () => {
    while (Date.now() < deadline) {
      const body = await stateOf(opts.origin, headers, fetchImpl, timeoutMs);
      const inst = exoInstanceFor(body, opts.model);
      if (inst?.failed) throw new Error(`${opts.model} failed on exo: ${inst.failed}`);
      if (inst?.ready) return;
      await pause();
    }
    throw new Error(`${opts.model} did not become ready on exo`);
  };

  const current = await stateOf(opts.origin, headers, fetchImpl, timeoutMs);
  if (exoInstanceFor(current, opts.model)) {
    await waitReady();
    return;
  }

  const place = async (placement: (typeof EXO_PLACEMENTS)[number]) => {
    const res = await fetchImpl(`${opts.origin}/place_instance`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: opts.model, ...placement }),
      signal: AbortSignal.timeout(Math.min(60_000, timeoutMs)),
    });
    if (res.ok) return "";
    return errorText(res);
  };

  const tryPlace = async () => {
    let memory = "";
    let other = "";
    for (const placement of EXO_PLACEMENTS) {
      const detail = await place(placement);
      if (!detail) return "placed" as const;
      if (wontFit(detail)) memory = detail;
      else other = detail;
      const now = await stateOf(opts.origin, headers, fetchImpl, timeoutMs).catch(() => null);
      if (now && exoInstanceFor(now, opts.model)) return "exists" as const;
    }
    return { memory, other };
  };

  let result = await tryPlace();
  if (result === "exists") {
    await waitReady();
    return;
  }
  if (result !== "placed") {
    const others = exoInstances(current).filter((i) => i.modelId.toLowerCase() !== opts.model.toLowerCase());
    if (result.memory && others.length && !opts.allowEvict) {
      throw new Error(`${opts.model} will not fit beside the exo instance already running (${others.map((i) => i.modelId).join(", ")}). Eviction is off.`);
    }
    if (result.memory && others.length && opts.allowEvict) {
      for (const inst of others) {
        const res = await fetchImpl(`${opts.origin}/instance/${encodeURIComponent(inst.id)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
      }
      result = await tryPlace();
    }
  }
  if (result === "placed" || result === "exists") {
    await waitReady();
    return;
  }
  const detail = result === "placed" || result === "exists" ? "" : result.memory || result.other;
  throw new Error(detail || `exo did not place ${opts.model}`);
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
