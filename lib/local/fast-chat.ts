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

/** Stage timings for a local chat turn. Printed only when BOPS_CHAT_TIMING=1. */
export function chatStage(stage: string, started: number, extra = "") {
  if (process.env.BOPS_CHAT_TIMING !== "1") return;
  console.log(`[chat] ${stage} ${Date.now() - started}ms${extra ? ` ${extra}` : ""}`);
}
