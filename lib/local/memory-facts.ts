/**
 * Facts taken from a chat after the reply is on screen.
 * Only sentences the user stated about themselves are kept. The assistant's
 * own reply, and a request to go do something, are not facts.
 */
import { asThirdPerson, sameFact } from "./memory-store";
import { localNeedsMemory, needsLocalTools, promisesAction } from "./fast-chat";

const DOING = /\b(updating|updated|installing|installed|running|restarting|downloaded|i(?:'|’)ll|i will|let me|the assistant)\b/i;

/** The user stated something lasting about themselves, rather than asking for work. */
export function statesUserFact(text: string): boolean {
  const t = text.trim();
  if (!t || promisesAction(t)) return false;
  if (needsLocalTools(t) && !/\b(remember|prefer|always|usually|i am|i'm)\b/i.test(t)) return false;
  return localNeedsMemory(t);
}

function grounded(userSaid: string, fact: string, name: string): boolean {
  const stop = new Set(["user", "that", "this", "with", "from", "they", "their", "about", "have", "has", "them", "your", name.toLowerCase()]);
  const words = fact
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w));
  if (!words.length) return false;
  const src = userSaid.toLowerCase();
  return words.some((w) => src.includes(w.slice(0, Math.min(5, w.length))));
}

/** Model lines, kept only when they restate the user and are not duplicates of each other. */
export function factsToKeep(userSaid: string, lines: string[], name: string): string[] {
  if (!statesUserFact(userSaid)) return [];
  const kept: string[] = [];
  for (const raw of lines) {
    const line = asThirdPerson(raw.replace(/^[-*•\d.)\s]+/, "").trim(), name);
    if (!line || /^none$/i.test(line) || line.length >= 400) continue;
    if (DOING.test(raw) || DOING.test(line)) continue;
    if (!grounded(userSaid, line, name)) continue;
    if (kept.some((have) => sameFact(have, line, name))) continue;
    kept.push(line);
    if (kept.length >= 3) break;
  }
  return kept;
}
