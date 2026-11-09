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
  if (TASKISH.test(t)) return false;
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
export function stripImitatedDeeds(text: string): { text: string; claimedTask?: string } {
  let claimedTask: string | undefined;
  for (const match of text.matchAll(IMITATED_DEED)) {
    const title = /started the task "([^"]+)"/.exec(match[1] ?? "");
    if (title) claimedTask = title[1];
  }
  return { text: text.replace(IMITATED_DEED, "").replace(/\n{3,}/g, "\n\n").trim(), claimedTask };
}

/** Stage timings for a local chat turn. Printed only when BOPS_CHAT_TIMING=1. */
export function chatStage(stage: string, started: number, extra = "") {
  if (process.env.BOPS_CHAT_TIMING !== "1") return;
  console.log(`[chat] ${stage} ${Date.now() - started}ms${extra ? ` ${extra}` : ""}`);
}
