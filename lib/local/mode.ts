/**
 * Local-only mode and the routing config.
 * Model names and which machine serves them live in bops.local.json (see bops.local.example.json).
 * Nothing here is tied to one IP. LAN endpoints must carry an apiKey; loopback may be open.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCloudModel } from "./models";

export type ProviderKind = "ollama" | "openai-compatible" | "llamacpp" | "lmstudio" | "mlx" | "vllm" | "exo";
export type Role = "planner" | "fast" | "vision" | "embed" | "heavy";

export type LlmEndpoint = {
  id: string;
  baseUrl: string;
  provider: ProviderKind;
  apiKey?: string;
};

export type ChainStep = {
  endpoint: string;
  model: string;
  /** Expected quant, recorded for the operator. A mismatch does not drop the model. */
  quant?: string;
};

export type LocalConfig = {
  llm: {
    endpoints: LlmEndpoint[];
    roles: Record<Role, { chain: ChainStep[] }>;
  };
  workers: { id: string; url: string; token?: string; kind?: "native" | "browser" | "fake" }[];
  memoryPath?: string;
};

const ROLES: Role[] = ["planner", "fast", "vision", "embed", "heavy"];

let override: LocalConfig | null = null;

/** Tests inject a config. Pass null to read the files again. */
export function useConfig(config: LocalConfig | null) {
  override = config;
}

export function localOnly(): boolean {
  const v = (process.env.BOPS_LOCAL_ONLY ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  const argv = process.argv.join(" ");
  if (/[/\\]scripts[/\\]test-[^/\\]+\.mjs/.test(argv) || /[/\\]cloud[/\\]test[/\\]/.test(argv)) return false;
  return true;
}

export function loadConfig(): LocalConfig {
  const base = override ?? readConfigFile();
  return applyEnv(structuredClone(base));
}

function readConfigFile(): LocalConfig {
  const custom = process.env.BOPS_LOCAL_CONFIG?.trim();
  // An explicit path wins, even when it is missing: never the copy under .next/standalone.
  if (custom) {
    if (existsSync(custom)) return parseConfig(readFileSync(custom, "utf8"), custom);
    const example = join(dirname(custom), "bops.local.example.json");
    if (existsSync(example)) return parseConfig(readFileSync(example, "utf8"), example);
    return emptyConfig();
  }
  const root = process.env.BOPS_REPO_ROOT?.trim();
  for (const file of [root ? join(root, "bops.local.json") : "", "bops.local.json", root ? join(root, "bops.local.example.json") : "", "bops.local.example.json"]) {
    if (file && existsSync(file)) return parseConfig(readFileSync(file, "utf8"), file);
  }
  return emptyConfig();
}

export function parseConfig(text: string, from: string): LocalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${from} is not valid JSON (${(e as Error).message}).`);
  }
  const src = (raw ?? {}) as {
    llm?: { endpoints?: Partial<LlmEndpoint>[]; roles?: Partial<Record<Role, { chain?: Partial<ChainStep>[] }>> };
    workers?: LocalConfig["workers"];
    memoryPath?: string;
  };
  const endpoints: LlmEndpoint[] = (src.llm?.endpoints ?? []).map((e, i) => ({
    id: String(e.id || `endpoint-${i + 1}`),
    baseUrl: String(e.baseUrl || "").replace(/\/+$/, ""),
    provider: (e.provider || "ollama") as ProviderKind,
    apiKey: e.apiKey?.trim() || "",
  })).filter((e) => e.baseUrl);
  const roles = {} as LocalConfig["llm"]["roles"];
  for (const role of ROLES) {
    const chain = src.llm?.roles?.[role]?.chain ?? [];
    roles[role] = {
      chain: chain
        .map((s) => ({ endpoint: String(s.endpoint || ""), model: String(s.model || "").trim(), ...(s.quant ? { quant: String(s.quant) } : {}) }))
        .filter((s) => s.endpoint && s.model && !isCloudModel(s.model)),
    };
  }
  return {
    llm: { endpoints, roles },
    workers: (src.workers ?? []).map((w) => ({ ...w, url: String(w.url || "").replace(/\/+$/, "") })).filter((w) => w.id && w.url),
    memoryPath: src.memoryPath,
  };
}

function emptyConfig(): LocalConfig {
  return {
    llm: {
      endpoints: [{ id: "studio3", baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama", apiKey: "" }],
      roles: {
        planner: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] },
        vision: { chain: [{ endpoint: "studio3", model: "qwen3.8:27b-q8_0" }] },
        fast: { chain: [{ endpoint: "studio3", model: "nemotron-3.5-lightning:30b" }] },
        embed: { chain: [{ endpoint: "studio3", model: "qwen3-embedding:8b" }] },
        heavy: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] },
      },
    },
    workers: [{ id: "studio3", url: "http://127.0.0.1:8791", token: "", kind: "native" }],
  };
}

/** An env model is prepended to that role's chain. A `:cloud` tag is dropped, not used. */
function applyEnv(cfg: LocalConfig): LocalConfig {
  const keys: Record<Role, string> = {
    planner: "BOPS_LLM_PLANNER_MODEL",
    fast: "BOPS_LLM_FAST_MODEL",
    vision: "BOPS_LLM_VISION_MODEL",
    embed: "BOPS_LLM_EMBED_MODEL",
    heavy: "BOPS_LLM_HEAVY_MODEL",
  };
  for (const role of ROLES) {
    const model = process.env[keys[role]]?.trim();
    if (!model || isCloudModel(model)) continue;
    const endpoint = process.env[`BOPS_LLM_${role.toUpperCase()}_ENDPOINT`]?.trim() || cfg.llm.roles[role].chain[0]?.endpoint || cfg.llm.endpoints[0]?.id || "studio3";
    const chain = cfg.llm.roles[role].chain.filter((s) => !(s.endpoint === endpoint && s.model === model));
    cfg.llm.roles[role].chain = [{ endpoint, model }, ...chain];
  }
  return cfg;
}

export function endpointById(id: string): LlmEndpoint | undefined {
  return loadConfig().llm.endpoints.find((e) => e.id === id);
}

export function roleChain(role: Role): ChainStep[] {
  return loadConfig().llm.roles[role]?.chain ?? [];
}
