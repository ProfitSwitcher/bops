/** Ollama tag checks. A `:cloud` tag is never a local model. glm-5.3-flash ships that way. */

export class CloudModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudModelError";
  }
}

export type ListedModel = {
  name: string;
  size: number;
  quant?: string;
  cloud: boolean;
};

export function isCloudModel(name: string, raw?: Record<string, unknown> | null): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (n.includes(":cloud")) return true;
  if (/(^|\/)cloud:/.test(n)) return true;
  if (raw && remote(raw)) return true;
  return false;
}

function remote(raw: Record<string, unknown>): boolean {
  if (typeof raw.remote_host === "string" && raw.remote_host) return true;
  if (raw.remote_model) return true;
  const details = raw.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (typeof d.remote_host === "string" && d.remote_host) return true;
    if (d.remote_model) return true;
  }
  return false;
}

export function assertLocalModel(name: string): void {
  const n = name.trim();
  if (!n) throw new CloudModelError("No local model name was given.");
  if (isCloudModel(n)) {
    throw new CloudModelError(
      `Refusing cloud model "${n}". Local-only mode never selects an Ollama tag containing ":cloud" (glm-5.3-flash is one of these).`,
    );
  }
}

/**
 * Model lists from Ollama 0.30, 0.32 and 0.34, and from OpenAI-compatible /v1/models
 * (llama.cpp, LM Studio, MLX, vLLM). Missing fields are skipped, not fatal.
 */
export function modelsFromTagsPayload(body: unknown): ListedModel[] {
  const root = body as { models?: unknown; data?: unknown } | unknown[] | null;
  const list = Array.isArray(root) ? root : Array.isArray(root?.models) ? root.models : Array.isArray(root?.data) ? root.data : [];
  const out: ListedModel[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push({ name: item, size: 0, cloud: isCloudModel(item) });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name || rec.model || rec.id || "").trim();
    if (!name) continue;
    const size = Number(rec.size ?? rec.size_vram ?? 0) || 0;
    const details = rec.details && typeof rec.details === "object" ? (rec.details as Record<string, unknown>) : undefined;
    const quant = details?.quantization_level ?? rec.quantization;
    out.push({
      name,
      size,
      ...(quant ? { quant: String(quant) } : {}),
      cloud: isCloudModel(name, rec),
    });
  }
  return out;
}

export function hasModel(models: ListedModel[] | null | undefined, name: string): boolean {
  if (!models) return true;
  const want = name.trim().toLowerCase();
  return models.some((m) => m.name.trim().toLowerCase() === want && !m.cloud);
}

/** Cloud tags removed. Used by the status page, not to invent a model the config didn't name. */
export function localModels(models: ListedModel[]): ListedModel[] {
  return models.filter((m) => !m.cloud && !isCloudModel(m.name));
}
