import { localOnly } from "@/lib/local/mode";
import { readLocalProfile, writeLocalProfile } from "@/lib/local/profile";
import { getState, update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** The person the bots work for (Settings → You): their name, and what the bots should know about them. */
export async function GET() {
  if (localOnly()) {
    const file = readLocalProfile();
    const owner = getState().owner;
    return Response.json({ name: file?.name || owner?.name || "", about: file?.about ?? owner?.about });
  }
  return Response.json(getState().owner ?? { name: "" });
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { name, about } = (await request.json().catch(() => ({}))) as { name?: unknown; about?: unknown };
  if (typeof name !== "string" || (about !== undefined && typeof about !== "string")) return Response.json({ error: "name (and about) must be text" }, { status: 400 });
  const next = { name: name.trim().slice(0, 80), about: about?.trim().slice(0, 600) || undefined };
  if (localOnly()) writeLocalProfile({ name: next.name, ...(next.about ? { about: next.about } : {}) });
  update((s) => {
    s.owner = next;
  });
  return Response.json(getState().owner);
}
