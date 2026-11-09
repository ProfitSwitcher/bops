import { localOnly } from "@/lib/local/mode";

export const dynamic = "force-dynamic";

/**
 * How this install is run, for the app's UI. Hosted (the default upstream) keeps the providers out of
 * sight. This fork is local-only unless BOPS_LOCAL_ONLY=0, and then Settings says what is offline.
 */
export async function GET() {
  const local = localOnly();
  return Response.json({ selfHosted: local || process.env.BOPS_SELF_HOSTED === "1", localOnly: local });
}
