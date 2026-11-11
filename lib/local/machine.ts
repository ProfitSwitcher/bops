/**
 * The machine this Bops process is running on, as the bots should name it.
 * BOPS_MACHINE_NAME wins. Otherwise the hostname, with studio3 written as Studio 3.
 */
import { hostname } from "node:os";

export function machineLabel(host = process.env.BOPS_MACHINE_NAME?.trim() || hostname()): string {
  const raw = host.replace(/\.local$/i, "").trim();
  if (!raw || raw.toLowerCase() === "localhost") return "this Mac";
  const split = raw.match(/^([A-Za-z]+)\s*[-_]?(\d+)$/);
  if (split) return `${split[1][0].toUpperCase()}${split[1].slice(1).toLowerCase()} ${split[2]}`;
  return raw;
}
