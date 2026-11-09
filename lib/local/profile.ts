/**
 * The person this Mac's Bops works for. Kept in bops.local.json when that file
 * exists, and always in the local app state. Nothing here is an Orgo account.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LocalProfile = { name: string; about?: string };

/** The live config file, never the example. Null when only the example is present. */
export function configPathForProfile(): string | null {
  const custom = process.env.BOPS_LOCAL_CONFIG?.trim();
  if (custom && existsSync(custom)) return custom;
  const root = process.env.BOPS_REPO_ROOT?.trim();
  for (const path of [root ? join(root, "bops.local.json") : "", join(process.cwd(), "bops.local.json")]) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

export function readLocalProfile(): LocalProfile | null {
  const path = configPathForProfile();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { profile?: { name?: unknown; about?: unknown } };
    const name = typeof raw.profile?.name === "string" ? raw.profile.name.trim().slice(0, 80) : "";
    const about = typeof raw.profile?.about === "string" ? raw.profile.about.trim().slice(0, 600) : "";
    if (!name && !about) return null;
    return { name, ...(about ? { about } : {}) };
  } catch {
    return null;
  }
}

/** Writes `profile` into the existing config and leaves every other field as it was. */
export function writeLocalProfile(profile: LocalProfile): LocalProfile {
  const name = profile.name.trim().slice(0, 80);
  const about = profile.about?.trim().slice(0, 600) || "";
  const saved: LocalProfile = { name, ...(about ? { about } : {}) };
  const path = configPathForProfile();
  if (!path) return saved;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.profile = saved.about ? { name: saved.name, about: saved.about } : { name: saved.name };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return saved;
}
