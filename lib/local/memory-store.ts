/**
 * Local memory: SQLite on disk, optional embeddings from the local embed role.
 * If the embedding model is missing, search falls back to word overlap.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "../server/user-paths";
import { embed } from "./provider";
import { loadConfig } from "./mode";
import { searchSharedBrain } from "./shared-brain";

export type Fact = { id: string; content: string; sessionId: string | null; createdAt: string };

let db: DatabaseSync | null = null;
let dbPath = "";

function memoryFile() {
  const set = process.env.BOPS_MEMORY_PATH?.trim() || loadConfig().memoryPath?.trim();
  if (!set) return join(dataRoot(), "local-memory.sqlite");
  if (isAbsolute(set)) return set;
  return join(dataRoot(), set.replace(/^\.data[\\/]/, ""));
}

export function memoryDb(path = memoryFile()) {
  if (db && dbPath === path) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      bank TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      embedding TEXT
    );
    CREATE TABLE IF NOT EXISTS cards (
      bank TEXT NOT NULL,
      line TEXT NOT NULL,
      PRIMARY KEY (bank, line)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      bank TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      bank TEXT NOT NULL,
      session_id TEXT NOT NULL,
      peer_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  dbPath = path;
  return db;
}

export function closeMemoryForTests() {
  db?.close();
  db = null;
  dbPath = "";
}

function row(r: { id: string; content: string; session_id: string | null; created_at: number }): Fact {
  return { id: r.id, content: r.content, sessionId: r.session_id, createdAt: new Date(r.created_at).toISOString() };
}

export async function addFacts(bank: string, items: { content: string; sessionId?: string }[], opts: { embedMs?: number } = {}): Promise<Fact[]> {
  const database = memoryDb();
  const made: Fact[] = [];
  let vectors: number[][] | null = null;
  try {
    const pending = embed(items.map((i) => i.content));
    vectors = opts.embedMs ? await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), opts.embedMs))]) : await pending;
  } catch {
    vectors = null;
  }
  const insert = database.prepare("INSERT INTO facts (id, bank, content, session_id, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < items.length; i++) {
    const id = randomUUID();
    const at = Date.now();
    const fact = items[i];
    insert.run(id, bank, fact.content, fact.sessionId ?? null, at, vectors ? JSON.stringify(vectors[i]) : null);
    made.push({ id, content: fact.content, sessionId: fact.sessionId ?? null, createdAt: new Date(at).toISOString() });
  }
  return made;
}

export function deleteFact(bank: string, id: string) {
  memoryDb().prepare("DELETE FROM facts WHERE bank = ? AND id = ?").run(bank, id);
}

export function getFacts(bank: string, ids: string[]): Fact[] {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = memoryDb().prepare(`SELECT id, content, session_id, created_at FROM facts WHERE bank = ? AND id IN (${marks})`).all(bank, ...ids) as { id: string; content: string; session_id: string | null; created_at: number }[];
  return rows.map(row);
}

export function listFacts(bank: string, opts: { sessionIds?: string[]; limit?: number } = {}): Fact[] {
  const limit = opts.limit ?? 100;
  if (opts.sessionIds) {
    if (!opts.sessionIds.length) return [];
    const marks = opts.sessionIds.map(() => "?").join(",");
    const rows = memoryDb().prepare(`SELECT id, content, session_id, created_at FROM facts WHERE bank = ? AND session_id IN (${marks}) ORDER BY created_at DESC LIMIT ?`).all(bank, ...opts.sessionIds, limit) as { id: string; content: string; session_id: string | null; created_at: number }[];
    return rows.map(row);
  }
  const rows = memoryDb().prepare("SELECT id, content, session_id, created_at FROM facts WHERE bank = ? ORDER BY created_at DESC LIMIT ?").all(bank, limit) as { id: string; content: string; session_id: string | null; created_at: number }[];
  return rows.map(row);
}

/** "my shop truck is blue" becomes "Sam's shop truck is blue". */
export function asThirdPerson(fact: string, name = "The user"): string {
  let t = fact.trim().replace(/^(please\s+)?remember(\s+for\s+later)?\s*[:,.\-]?\s*/i, "");
  t = t.replace(/\bI'm\b/g, `${name} is`).replace(/\bI am\b/gi, `${name} is`).replace(/\bI've\b/g, `${name} has`);
  t = t.replace(/\bmy\b/gi, `${name}'s`).replace(/\bmine\b/gi, `${name}'s`);
  t = t.replace(/\bI\b/g, name);
  return t.replace(/\s+/g, " ").trim();
}

/** True when two facts say the same thing, ignoring first person and punctuation. */
export function sameFact(a: string, b: string, name = "The user"): boolean {
  const na = asThirdPerson(a, name).toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  const nb = asThirdPerson(b, name).toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (!ta.size || !tb.size) return false;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n / Math.min(ta.size, tb.size) >= 0.8;
}

export async function closestFact(bank: string, query: string): Promise<{ content: string; score: number } | null> {
  const rows = memoryDb().prepare("SELECT content, embedding FROM facts WHERE bank = ?").all(bank) as { content: string; embedding: string | null }[];
  if (!rows.length) return null;
  let queryVec: number[] | null = null;
  if (rows.some((r) => r.embedding)) {
    try {
      queryVec = (await embed([query]))[0] ?? null;
    } catch {
      queryVec = null;
    }
  }
  let best: { content: string; score: number } | null = null;
  const words = tokens(query);
  for (const r of rows) {
    const vec = r.embedding ? (JSON.parse(r.embedding) as number[]) : null;
    const cosine = queryVec && vec ? similarity(queryVec, vec) : 0;
    const lexical = overlap(words, tokens(r.content));
    const score = Math.max(cosine, lexical);
    if (!best || score > best.score) best = { content: r.content, score };
  }
  return best;
}

export async function searchFacts(bank: string, query: string, limit: number): Promise<Fact[]> {
  const rows = memoryDb().prepare("SELECT id, content, session_id, created_at, embedding FROM facts WHERE bank = ?").all(bank) as { id: string; content: string; session_id: string | null; created_at: number; embedding: string | null }[];
  let queryVec: number[] | null = null;
  if (rows.some((r) => r.embedding)) {
    try {
      queryVec = (await embed([query]))[0] ?? null;
    } catch {
      queryVec = null;
    }
  }
  const words = tokens(query);
  const ranked = rows
    .map((r) => {
      const vec = r.embedding ? (JSON.parse(r.embedding) as number[]) : null;
      const cosine = queryVec && vec ? similarity(queryVec, vec) : 0;
      const lexical = overlap(words, tokens(r.content));
      return { fact: row(r), score: Math.max(cosine, lexical) };
    })
    .sort((a, b) => b.score - a.score);
  const local = ranked.slice(0, limit).map((r) => r.fact);
  const shared = await searchSharedBrain(query, 3);
  const extra = shared
    .filter((h) => !local.some((f) => f.content.toLowerCase().includes(h.content.toLowerCase().slice(0, 48))))
    .map((h) => ({ id: "shared", content: `Shared memory: ${h.content}`, sessionId: null, createdAt: new Date().toISOString() }));
  return [...local, ...extra];
}

export function cardLines(bank: string): string[] {
  return (memoryDb().prepare("SELECT line FROM cards WHERE bank = ? ORDER BY line").all(bank) as { line: string }[]).map((r) => r.line);
}

export function setCardLines(bank: string, lines: string[]) {
  const database = memoryDb();
  database.prepare("DELETE FROM cards WHERE bank = ?").run(bank);
  const insert = database.prepare("INSERT OR IGNORE INTO cards (bank, line) VALUES (?, ?)");
  for (const line of lines) insert.run(bank, line);
}

export function ensureSession(bank: string, id: string) {
  memoryDb().prepare("INSERT OR IGNORE INTO sessions (id, bank) VALUES (?, ?)").run(id, bank);
}

export function deleteSession(bank: string, id: string) {
  const database = memoryDb();
  database.prepare("DELETE FROM messages WHERE bank = ? AND session_id = ?").run(bank, id);
  database.prepare("DELETE FROM facts WHERE bank = ? AND session_id = ?").run(bank, id);
  database.prepare("DELETE FROM sessions WHERE bank = ? AND id = ?").run(bank, id);
}

export function addMessages(bank: string, sessionId: string, messages: { peerId: string; content: string }[]) {
  ensureSession(bank, sessionId);
  const insert = memoryDb().prepare("INSERT INTO messages (id, bank, session_id, peer_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const m of messages) insert.run(randomUUID(), bank, sessionId, m.peerId, m.content, Date.now());
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.sqrt(a.size * b.size);
}

function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
