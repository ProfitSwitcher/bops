import { candidates } from "@/lib/local/endpoints";
import { exoWarmup } from "@/lib/local/exo";
import { offlineFeatures } from "@/lib/local/features";
import { loadConfig, localOnly, type Role } from "@/lib/local/mode";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["planner", "fast", "vision", "embed", "heavy"];

/** What this local-only install is using, and which hosted features are turned off. */
export async function GET() {
  if (!localOnly()) return Response.json({ localOnly: false, features: [], roles: {} });
  const cfg = loadConfig();
  const roles: Record<string, unknown> = {};
  for (const role of ROLES) {
    const found = await candidates(role);
    roles[role] = {
      chain: cfg.llm.roles[role].chain,
      ready: found.ready.map((a) => ({ endpoint: a.endpoint.id, model: a.model, quant: a.quant })),
      skipped: found.skipped,
    };
  }
  const warming = exoWarmup();
  return Response.json({
    localOnly: true,
    features: offlineFeatures(),
    exo: warming ? { warming: { endpoint: warming.endpoint, model: warming.model, forMs: Date.now() - warming.since } } : { warming: null },
    roles,
    endpoints: cfg.llm.endpoints.map((e) => ({ id: e.id, baseUrl: e.baseUrl, provider: e.provider, authenticated: !!(e.apiKey && e.apiKey !== "") })),
    workers: cfg.workers.map((w) => ({ id: w.id, url: w.url, kind: w.kind ?? "native" })),
  });
}
