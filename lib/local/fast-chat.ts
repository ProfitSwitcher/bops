/**
 * A short local chat that can be answered with one small prompt.
 * Task words, pictures, files, and thread replies stay on the full path.
 */
const TASKISH =
  /\b(screenshot|computer|email|e-mail|search|schedule|remind|browse|click|open|file|folder|code|skill|routine|watch|deploy|website|inbox|calendar|task|thread)\b/i;

export function isSimpleLocalChat(text: string | undefined, extras: { images?: boolean; files?: boolean; thread?: boolean } = {}): boolean {
  if (extras.images || extras.files || extras.thread) return false;
  const t = (text ?? "").trim();
  if (!t || t.length > 240) return false;
  if (TASKISH.test(t) || localNeedsMemory(t)) return false;
  return true;
}

/** A local message needs a memory search only when it is about the person, not a task to go and do. */
export function localNeedsMemory(said: string): boolean {
  return /\b(remember|prefer|always|usually|who am i|about me|my )\b/i.test(said);
}

const IMITATED_DEED = /\[What was done:([^\]]*)\]/g;

/**
 * A model that copies a history note like `[What was done: started the task "..."]` did not call start_task.
 * The note comes off the reply. `claimedTask` is the title it pretended to start.
 */
/** The user asked for a task, or the reply promises computer work, and no tool was called. */
export function asksForTask(text: string): boolean {
  return /\b(start (?:another |a )?task|use start_task)\b/i.test(text);
}

export function claimsWork(text: string): boolean {
  return /\b(moving the pointer|taking a screenshot|screenshot now|i(?:'|’)ll (?:click|move|open|type|start)|clicking)\b/i.test(text);
}

/**
 * A reply that promises work without a tool call. A finished thread already in `history` does not count as this task.
 */
export function taskFromPromise(user: string, reply: string, calledTool: boolean, history = ""): { title: string; goal: string } | null {
  void history;
  if (calledTool) return null;
  if (!asksForTask(user) && !claimsWork(reply)) return null;
  const title = user.replace(/\s+/g, " ").trim().slice(0, 80) || "Task";
  return { title, goal: user };
}

export function stripImitatedDeeds(text: string): { text: string; claimedTask?: string } {
  let claimedTask: string | undefined;
  for (const match of text.matchAll(IMITATED_DEED)) {
    const title = /started the task "([^"]+)"/.exec(match[1] ?? "");
    if (title) claimedTask = title[1];
  }
  return { text: text.replace(IMITATED_DEED, "").replace(/\n{3,}/g, "\n\n").trim(), claimedTask };
}

/** The user message's `at`, so every stage can be read as time since they sent it. */
let clockAt = 0;
export function chatClock(at: number) {
  if (at) clockAt = at;
}

/** Stage timings for a local chat turn. Printed only when BOPS_CHAT_TIMING=1. Offset is since the message; the parenthetical is this stage's own duration. */
export function chatStage(stage: string, started: number, extra = "") {
  if (process.env.BOPS_CHAT_TIMING !== "1") return;
  const now = Date.now();
  const since = clockAt ? now - clockAt : now - started;
  const dur = now - started;
  console.log(`[chat] ${stage} +${since}ms (${dur}ms)${extra ? ` ${extra}` : ""}`);
}
