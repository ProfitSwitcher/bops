/**
 * Per-role routing across LAN inference endpoints.
 * A step is skipped when the machine is down, the tag is `:cloud`, or that Ollama
 * doesn't have the model. The next configured local model is tried. No cloud fallback.
 */
import { assertLocalHost, isLocalAddress } from "./egress.mjs";
import { modelsFromExoState } from "./exo";
import { assertLocalModel, CloudModelError, hasModel, isCloudModel, modelsFromTagsPayload, type ListedModel } from "./models";
import { endpointById, loadConfig, roleChain, type ChainStep, type LlmEndpoint, type Role } from "./mode";

export type Health = {
  ok: boolean;
  error?: string;
  /** Null when the server answered but didn't list models (try the request anyway). Empty means none are usable. */
  models: ListedModel[] | null;
  /** exo models that are present but not DownloadCompleted. Never sent a chat request. */
  partial?: string[];
};

const cache = new Map<string, { at: number; health: Health }>();
const TTL_MS = 15_000;
const PROBE_MS = 1_200;

export function clearHealth() {
  cache.clear();
}

export function authHeaders(ep: LlmEndpoint): Record<string, string> {
  return ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {};
}

export function originOf(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.origin;
}

function loopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export async function checkEndpoint(ep: LlmEndpoint, fetchImpl: typeof fetch = fetch): Promise<Health> {
  let url: URL;
  try {
    url = new URL(ep.baseUrl);
  } catch {
    return { ok: false, error: `${ep.id} has a base URL that isn't valid`, models: null };
  }
  try {
    assertLocalHost(url.hostname);
  } catch (e) {
    return { ok: false, error: (e as Error).message, models: null };
  }
  if (!loopback(url.hostname) && !isLocalAddress(url.hostname) && !ep.apiKey) {
    return { ok: false, error: `${ep.id} is not on this machine and has no apiKey. LAN inference has to be authenticated.`, models: null };
  }
  if (!loopback(url.hostname) && !ep.apiKey) {
    return { ok: false, error: `${ep.id} is on the LAN and has no apiKey. Refusing an unauthenticated inference call.`, models: null };
  }
  const key = `${ep.id}|${ep.baseUrl}|${ep.apiKey ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.health;
  const health = await probe(ep, fetchImpl);
  cache.set(key, { at: Date.now(), health });
  return health;
}

export function markUnhealthy(ep: LlmEndpoint, error: string) {
  const key = `${ep.id}|${ep.baseUrl}|${ep.apiKey ?? ""}`;
  cache.set(key, { at: Date.now(), health: { ok: false, error, models: null } });
}

async function probe(ep: LlmEndpoint, fetchImpl: typeof fetch): Promise<Health> {
  if (ep.provider === "exo") return probeExo(ep, fetchImpl);
  const headers = authHeaders(ep);
  const origin = originOf(ep.baseUrl);
  const base = ep.baseUrl.replace(/\/+$/, "");
  const urls =
    ep.provider === "ollama"
      ? [`${origin}/api/tags`, `${base}/models`, `${origin}/v1/models`]
      : [`${base}/models`, `${origin}/v1/models`, `${origin}/api/tags`, `${origin}/health`];
  let last = "no answer";
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_MS) });
      if (!res.ok) {
        last = `${res.status} from ${url}`;
        continue;
      }
      const body = await res.json().catch(() => null);
      if (url.endsWith("/health") && body && typeof body === "object" && "ok" in body && !(body as { ok?: boolean }).ok) {
        last = `${ep.id} health check failed`;
        continue;
      }
      const models = modelsFromTagsPayload(body).filter((m) => !m.cloud);
      return { ok: true, models: models.length ? models : null };
    } catch (e) {
      last = (e as Error).message;
    }
  }
  return { ok: false, error: last, models: null };
}

/** Inventory comes from GET /state only. The /v1/models catalog includes models that are not on disk. */
async function probeExo(ep: LlmEndpoint, fetchImpl: typeof fetch): Promise<Health> {
  const headers = authHeaders(ep);
  try {
    const res = await fetchImpl(`${originOf(ep.baseUrl)}/state`, { headers, signal: AbortSignal.timeout(PROBE_MS) });
    if (!res.ok) return { ok: false, error: `${res.status} from /state`, models: null };
    const { downloaded, downloading } = modelsFromExoState(await res.json().catch(() => null));
    return {
      ok: true,
      models: downloaded.filter((name) => !isCloudModel(name)).map((name) => ({ name, size: 0, cloud: false })),
      partial: downloading,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, models: null };
  }
}

export type Attempt = { endpoint: LlmEndpoint; model: string; quant?: string };

/** Ordered local candidates for a role. Cloud tags and unknown endpoints are reported in `skipped`. */
export async function candidates(role: Role, preferModel?: string, fetchImpl: typeof fetch = fetch): Promise<{ ready: Attempt[]; skipped: string[] }> {
  const fetchFn = fetchImpl ?? fetch;
  const skipped: string[] = [];
  let chain = roleChain(role);
  if (preferModel && !isCloudModel(preferModel)) {
    const i = chain.findIndex((s) => s.model.toLowerCase() === preferModel.toLowerCase());
    if (i > 0) chain = [chain[i], ...chain.filter((_, n) => n !== i)];
  }
  const ready: Attempt[] = [];
  for (const step of chain) ready.push(...(await consider(step, skipped, fetchFn)));
  return { ready, skipped };
}

async function consider(step: ChainStep, skipped: string[], fetchImpl: typeof fetch): Promise<Attempt[]> {
  try {
    assertLocalModel(step.model);
  } catch (e) {
    skipped.push(`${step.endpoint} ${step.model}: ${(e as Error).message}`);
    return [];
  }
  const ep = endpointById(step.endpoint);
  if (!ep) {
    skipped.push(`${step.endpoint}: no endpoint with that id`);
    return [];
  }
  const health = await checkEndpoint(ep, fetchImpl);
  if (!health.ok) {
    skipped.push(`${ep.id}: ${health.error ?? "unreachable"}`);
    return [];
  }
  if (health.partial?.some((id) => id.toLowerCase() === step.model.toLowerCase())) {
    skipped.push(`${ep.id} ${step.model} is still downloading, so it is not used`);
    return [];
  }
  if (health.models && !hasModel(health.models, step.model)) {
    skipped.push(`${ep.id} does not have ${step.model}`);
    return [];
  }
  return [{ endpoint: ep, model: step.model, ...(step.quant ? { quant: step.quant } : {}) }];
}

export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

/**
 * Run `fn` on each healthy local candidate until one returns.
 * A thrown CloudModelError stops the walk. Any other error tries the next model.
 */
export async function withRole<T>(
  role: Role,
  fn: (attempt: Attempt) => Promise<T>,
  opts: { preferModel?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ value: T; attempt: Attempt; skipped: string[] }> {
  const { ready, skipped } = await candidates(role, opts.preferModel, opts.fetchImpl);
  for (const attempt of ready) {
    try {
      const value = await fn(attempt);
      return { value, attempt, skipped };
    } catch (e) {
      if (e instanceof CloudModelError) throw e;
      const message = (e as Error).message;
      // A missing or broken model is not a dead machine: the next tag on that same host still gets a turn.
      if (/ECONNREFUSED|ECONNRESET|fetch failed|timed out|Timeout|aborted|ENOTFOUND|EHOSTUNREACH|socket/i.test(message)) markUnhealthy(attempt.endpoint, message);
      skipped.push(`${attempt.endpoint.id} ${attempt.model}: ${message}`);
    }
  }
  const cfg = loadConfig();
  const named = cfg.llm.roles[role].chain.map((s) => `${s.model} on ${s.endpoint}`).join(", ");
  throw new ModelUnavailable(
    `No local ${role} model answered (${named || "none configured"}). ${skipped.join(" | ") || "Nothing was reachable."} Local-only mode does not fall back to a cloud model.`,
  );
}
