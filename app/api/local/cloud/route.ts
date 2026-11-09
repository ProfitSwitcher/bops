import { cloudPolicy, listCloudModels, publicCloudStatus, redactSecrets, removeCloudKey, saveCloudKey, setCloudPolicy, type CloudMode, type CloudProviderId } from "@/lib/local/cloud";
import type { Role } from "@/lib/local/mode";

export const dynamic = "force-dynamic";

const PROVIDERS = new Set<CloudProviderId>(["xai", "openai", "anthropic"]);
const ROLES = new Set<Role>(["planner", "fast", "vision", "embed", "heavy"]);
const MODES = new Set<CloudMode>(["off", "prefer", "fallback"]);

/** Key status and role choices. The key itself is never returned. */
export async function GET() {
  return Response.json(publicCloudStatus());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { op?: string; allow?: boolean; provider?: CloudProviderId; key?: string; role?: Role; mode?: CloudMode; model?: string } | null;
  if (!body?.op) return Response.json({ error: "Missing request." }, { status: 400 });
  try {
    if (body.op === "allow") {
      const current = cloudPolicy();
      setCloudPolicy({ allow: body.allow === true, roles: current.roles });
      return Response.json(publicCloudStatus());
    }
    if (body.op === "key") {
      if (!body.provider || !PROVIDERS.has(body.provider)) return Response.json({ error: "Unknown provider." }, { status: 400 });
      await saveCloudKey(body.provider, String(body.key ?? ""));
      return Response.json(publicCloudStatus());
    }
    if (body.op === "remove") {
      if (!body.provider || !PROVIDERS.has(body.provider)) return Response.json({ error: "Unknown provider." }, { status: 400 });
      await removeCloudKey(body.provider);
      return Response.json(publicCloudStatus());
    }
    if (body.op === "test") {
      if (!body.provider || !PROVIDERS.has(body.provider)) return Response.json({ error: "Unknown provider." }, { status: 400 });
      const models = await listCloudModels(body.provider);
      return Response.json({ ok: true, models });
    }
    if (body.op === "role") {
      if (!body.role || !ROLES.has(body.role) || !body.mode || !MODES.has(body.mode)) return Response.json({ error: "Unknown role." }, { status: 400 });
      const current = cloudPolicy();
      const roles = { ...current.roles };
      if (body.mode === "off") delete roles[body.role];
      else {
        if (!body.provider || !PROVIDERS.has(body.provider) || !body.model?.trim()) return Response.json({ error: "Pick a provider and a model." }, { status: 400 });
        roles[body.role] = { mode: body.mode, provider: body.provider, model: body.model.trim() };
      }
      setCloudPolicy({ allow: current.allow, roles });
      return Response.json(publicCloudStatus());
    }
    return Response.json({ error: "Unknown request." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: redactSecrets((e as Error).message || "That did not work.") }, { status: 400 });
  }
}
