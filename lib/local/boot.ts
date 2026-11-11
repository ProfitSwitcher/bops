import { cloudPolicy } from "./cloud";
import { installEgressGuard } from "./egress.mjs";
import { allowEgress, localOnly } from "./mode";

/** Called when the server starts. Turns the hosted defaults off and installs the egress guard. */
export function bootLocal() {
  if (!localOnly()) return;
  process.env.BOPS_SELF_HOSTED = "1";
  process.env.BOPS_TELEMETRY = "0";
  process.env.DO_NOT_TRACK = "1";
  process.env.BOPS_RESPONSES_WS = "0";
  // BOPS_ALLOW_EGRESS=1 keeps local-only mode (local models, no cloud sign-in) but skips the socket guard.
  if (!allowEgress()) installEgressGuard();
  cloudPolicy();
}
