/**
 * exo (exo-labs) cluster state. GET /state is the only inventory we trust.
 * A model is eligible when at least one node has DownloadCompleted for it and
 * no node has DownloadOngoing or DownloadFailed. A leftover DownloadPending on
 * another node does not block it: placement stays on the nodes that already
 * have the weights. A partial download is never requested, so a chat cannot
 * start a Hugging Face fetch.
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

/** Consecutive placement failures before exo is skipped, then how long the skip lasts. */
const FAIL_LIMIT = () => {
  const n = Number(process.env.BOPS_EXO_FAIL_LIMIT);
  return Number.isFinite(n) && n >= 1 ? n : 2;
};
const COOLDOWN_MS = () => {
  const n = Number(process.env.BOPS_EXO_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 1 ? n : 30 * 60 * 1000;
};

type Breaker = { failures: number; until: number };
const breakers = new Map<string, Breaker>();

export function resetExoForTests() {
  warming = null;
  breakers.clear();
}

function notePlacementSuccess(origin: string) {
  breakers.delete(origin);
}

function notePlacementFailure(origin: string) {
  const row = breakers.get(origin) ?? { failures: 0, until: 0 };
  row.failures += 1;
  if (row.failures >= FAIL_LIMIT()) row.until = Date.now() + COOLDOWN_MS();
  breakers.set(origin, row);
}

function exoSkipReason(origin: string): string | undefined {
  const row = breakers.get(origin);
  if (!row || row.until <= Date.now()) return undefined;
  const minutes = Math.max(1, Math.round((row.until - Date.now()) / 60_000));
  return `exo is skipped for ${minutes} minute${minutes === 1 ? "" : "s"} after repeated placement failures`;
}

/** Default wait for an already-downloaded exo model to load into memory. */
export function exoLoadTimeoutMs(): number {
  const n = Number(process.env.BOPS_EXO_LOAD_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : 10 * 60_000;
}

export type ExoPlacement = { sharding: string; instance_meta: string; min_nodes: number; nodes: string[] };

/**
 * Pick a preview whose every node already has the model. A multi-node tensor
 * placement is used only when each of those nodes is complete. Otherwise the
 * pipeline preview on the single node that has the weights wins. A preview that
 * would include any other node is dropped, so place_instance cannot start a download.
 */
export function chooseExoPlacement(body: unknown, completeNodes: readonly string[]): ExoPlacement | undefined {
  const have = new Set(completeNodes.map((n) => n.toLowerCase()));
  const safe = parsePreviews(body).filter((p) => !p.error && p.nodes.length > 0 && p.nodes.every((n) => have.has(n.toLowerCase())));
  const multi = safe.filter((p) => p.nodes.length >= 2);
  const pool = multi.length ? multi : safe.filter((p) => p.nodes.length === 1);
  if (!pool.length) return undefined;
  const best = pool.slice().sort((a, b) => rankPlacement(b, multi.length > 0) - rankPlacement(a, multi.length > 0))[0];
  return { sharding: best.sharding, instance_meta: best.instance_meta, min_nodes: best.nodes.length, nodes: best.nodes };
}

function rankPlacement(p: { sharding: string; instance_meta: string; nodes: string[] }, multi: boolean): number {
  if (multi) {
    const tensor = p.sharding.toLowerCase() === "tensor" ? 3 : 0;
    const jaccl = /jaccl/i.test(p.instance_meta) ? 1 : 0;
    return p.nodes.length * 10 + tensor + jaccl;
  }
  const pipeline = p.sharding.toLowerCase() === "pipeline" ? 3 : 0;
  const ring = /ring/i.test(p.instance_meta) ? 1 : 0;
  return pipeline + ring;
}

function parsePreviews(body: unknown): { sharding: string; instance_meta: string; nodes: string[]; error: string }[] {
  const root = Array.isArray(body) ? body : body && typeof body === "object" ? ((body as Record<string, unknown>).previews ?? (body as Record<string, unknown>).data) : [];
  if (!Array.isArray(root)) return [];
  return root.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const sharding = String(rec.sharding ?? "");
    const instance_meta = String(rec.instanceMeta ?? rec.instance_meta ?? "");
    if (!sharding || !instance_meta) return [];
    const err = rec.error;
    return [{ sharding, instance_meta, nodes: nodesOfPreview(rec), error: typeof err === "string" ? err : err ? String(err) : "" }];
  });
}

function nodesOfPreview(rec: Record<string, unknown>): string[] {
  const inst = unwrapInstance(rec.instance);
  const shards = (inst.shardAssignments ?? inst.shard_assignments) as Record<string, unknown> | undefined;
  const map = (shards?.nodeToRunner ?? shards?.node_to_runner) as Record<string, unknown> | undefined;
  if (map && typeof map === "object") return Object.keys(map);
  const mem = (rec.memoryDeltaByNode ?? rec.memory_delta_by_node) as Record<string, unknown> | undefined;
  if (mem && typeof mem === "object") return Object.keys(mem);
  return [];
}

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
  const skipped = exoSkipReason(opts.origin);
  if (skipped) throw new Error(skipped);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? exoLoadTimeoutMs();
  const headers = { ...opts.headers, Accept: "application/json" };
  const deadline = Date.now() + timeoutMs;
  const pause = () => sleep(timeoutMs < 5_000 ? 20 : 500);
  const before = new Set<string>();
  const owned = new Set<string>();
  let placedOk = false;

  const track = (body: unknown) => {
    if (!placedOk) return;
    for (const inst of exoInstances(body)) if (!before.has(inst.id)) owned.add(inst.id);
  };

  /** Drop instances this attempt created. An instance that was already running is left alone. */
  const giveUp = async (message: string): Promise<never> => {
    const notes: string[] = [];
    if (placedOk) {
      for (const id of owned) {
        try {
          const res = await fetchImpl(`${opts.origin}/instance/${encodeURIComponent(id)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) });
          if (!res.ok && res.status !== 404) notes.push(await errorText(res));
        } catch (e) {
          notes.push((e as Error).message);
        }
      }
      notePlacementFailure(opts.origin);
    }
    const removed = placedOk && owned.size ? " Removed the instance this attempt created." : "";
    throw new Error(`${message}${removed}${notes.length ? ` (${notes.join("; ")})` : ""}`);
  };

  const waitReady = async () => {
    while (Date.now() < deadline) {
      const body = await stateOf(opts.origin, headers, fetchImpl, timeoutMs);
      track(body);
      const broken = exoInstances(body).find((inst) => owned.has(inst.id) && inst.failed);
      if (broken?.failed) await giveUp(`${opts.model} failed on exo: ${broken.failed}`);
      const inst = exoInstanceFor(body, opts.model);
      if (inst?.failed) throw new Error(`${opts.model} failed on exo: ${inst.failed}`);
      if (inst?.ready) {
        notePlacementSuccess(opts.origin);
        return;
      }
      await pause();
    }
    await giveUp(`${opts.model} did not become ready on exo`);
  };

  const current = await stateOf(opts.origin, headers, fetchImpl, timeoutMs);
  for (const inst of exoInstances(current)) before.add(inst.id);
  if (exoInstanceFor(current, opts.model)) {
    await waitReady();
    return;
  }

  const place = async (placement: ExoPlacement) => {
    const res = await fetchImpl(`${opts.origin}/place_instance`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: opts.model, sharding: placement.sharding, instance_meta: placement.instance_meta, min_nodes: placement.min_nodes }),
      signal: AbortSignal.timeout(Math.min(60_000, timeoutMs)),
    });
    if (res.ok) return "";
    return errorText(res);
  };

  const tryPlace = async () => {
    const body = await stateOf(opts.origin, headers, fetchImpl, timeoutMs);
    const nodes = exoModelNodes(body, opts.model);
    if (nodes.blocked) throw new Error(`${opts.model} is still downloading on exo`);
    if (!nodes.complete.length) throw new Error(`${opts.model} is not fully downloaded on an exo node`);
    const previewRes = await fetchImpl(`${opts.origin}/instance/previews?model_id=${encodeURIComponent(opts.model)}`, {
      headers,
      signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
    });
    let choice: ExoPlacement | undefined;
    if (previewRes.ok) {
      choice = chooseExoPlacement(await previewRes.json().catch(() => null), nodes.complete);
      if (!choice) throw new Error(`${opts.model} would need a download on a node that does not have it. Not placing it.`);
    } else {
      choice = { sharding: "Pipeline", instance_meta: "MlxRing", min_nodes: 1, nodes: nodes.complete.slice(0, 1) };
    }
    const detail = await place(choice);
    if (!detail) {
      placedOk = true;
      return "placed" as const;
    }
    const now = await stateOf(opts.origin, headers, fetchImpl, timeoutMs).catch(() => null);
    if (now && exoInstanceFor(now, opts.model)) return "exists" as const;
    return wontFit(detail) ? { memory: detail, other: "" } : { memory: "", other: detail };
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
  throw new Error(result.memory || result.other || `exo did not place ${opts.model}`);
}

/** Per-node download status. Pending is not a block: another node's completed copy can still be placed. */
export function exoModelNodes(body: unknown, model: string): { complete: string[]; pending: string[]; blocked: boolean } {
  const name = model.toLowerCase();
  const byNode = new Map<string, Set<DownloadStatus>>();
  for (const entry of downloadEntries(body)) {
    if (entry.model.toLowerCase() !== name) continue;
    const set = byNode.get(entry.node) ?? new Set();
    set.add(entry.status);
    byNode.set(entry.node, set);
  }
  const complete: string[] = [];
  const pending: string[] = [];
  let blocked = false;
  for (const [node, set] of byNode) {
    if (set.has("ongoing") || set.has("failed")) {
      blocked = true;
      continue;
    }
    if (set.has("complete")) complete.push(node);
    else if (set.has("pending")) pending.push(node);
  }
  return { complete, pending, blocked };
}

export function modelsFromExoState(body: unknown): ExoInventory {
  const rows = new Map<string, { complete: boolean; blocked: boolean }>();
  for (const entry of downloadEntries(body)) {
    const row = rows.get(entry.model) ?? { complete: false, blocked: false };
    if (entry.status === "complete") row.complete = true;
    if (entry.status === "ongoing" || entry.status === "failed") row.blocked = true;
    rows.set(entry.model, row);
  }
  const downloaded: string[] = [];
  const downloading: string[] = [];
  for (const [id, row] of rows) {
    if (row.blocked) downloading.push(id);
    else if (row.complete) downloaded.push(id);
  }
  return { downloaded, downloading };
}

type DownloadStatus = "complete" | "pending" | "ongoing" | "failed";

function downloadEntries(body: unknown): { node: string; model: string; status: DownloadStatus }[] {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const downloads = root.downloads;
  if (!downloads || typeof downloads !== "object") return [];
  const out: { node: string; model: string; status: DownloadStatus }[] = [];
  for (const [nodeKey, group] of Object.entries(downloads as Record<string, unknown>)) {
    const items = Array.isArray(group) ? group : group ? [group] : [];
    for (const item of items) {
      const found = classify(item);
      if (!found.id || !found.status) continue;
      out.push({ node: found.node || nodeKey, model: found.id, status: found.status });
    }
  }
  return out;
}

function classify(item: unknown): { id?: string; status?: DownloadStatus; node?: string } {
  if (!item || typeof item !== "object") return {};
  const rec = item as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const status = downloadStatus(key);
    if (!status) continue;
    const inner = rec[key];
    if (!inner || typeof inner !== "object") continue;
    const obj = inner as Record<string, unknown>;
    return { id: modelId(obj), status, node: typeof obj.nodeId === "string" ? obj.nodeId : typeof obj.node_id === "string" ? obj.node_id : undefined };
  }
  const statusText = String(rec.status ?? rec.type ?? rec.kind ?? "");
  const id = modelId(rec);
  if (/fail/i.test(statusText)) return { id, status: "failed" };
  if (/ongoing|in_progress/i.test(statusText)) return { id, status: "ongoing" };
  if (/pending/i.test(statusText)) return { id, status: "pending" };
  if (/complete/i.test(statusText)) return { id, status: "complete" };
  return { id };
}

function downloadStatus(key: string): DownloadStatus | undefined {
  if (key === "DownloadCompleted") return "complete";
  if (key === "DownloadPending") return "pending";
  if (key === "DownloadOngoing") return "ongoing";
  if (key === "DownloadFailed") return "failed";
  return undefined;
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
