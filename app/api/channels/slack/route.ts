import { localOnly } from "@/lib/local/mode";
import { slackChannels } from "@/lib/server/channels";

/** The Slack channels the user's Slack app can see, for picking where a bot goes. */
export async function GET(request: Request) {
  if (localOnly()) return Response.json({ channels: [], off: true, error: "Slack is unavailable offline." });
  const account = new URL(request.url).searchParams.get("account") ?? "";
  try {
    return Response.json({ channels: await slackChannels(account) });
  } catch (e) {
    return Response.json({ channels: [], error: (e as Error).message }, { status: 502 });
  }
}
