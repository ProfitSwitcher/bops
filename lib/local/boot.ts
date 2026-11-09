import { installEgressGuard } from "./egress.mjs";
import { localOnly } from "./mode";

/** Called when the server starts. Turns the cloud paths off and installs the egress guard. */
export function bootLocal() {
  if (!localOnly()) return;
  process.env.BOPS_SELF_HOSTED = "1";
  process.env.BOPS_TELEMETRY = "0";
  process.env.DO_NOT_TRACK = "1";
  process.env.BOPS_RESPONSES_WS = "0";
  installEgressGuard();
}
