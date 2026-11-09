/**
 * Speech on this machine. Audio is never sent to a cloud host.
 * A local whisper server (BOPS_LLM_TRANSCRIBE_URL) or a whisper.cpp binary
 * (BOPS_WHISPER_BIN, model at BOPS_WHISPER_MODEL) does the transcription.
 * Spoken replies can use macOS `say` when that command exists.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function transcribeLocal(audio: Buffer, mime = "audio/webm"): Promise<string> {
  const url = process.env.BOPS_LLM_TRANSCRIBE_URL?.trim();
  if (url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": mime || "application/octet-stream" },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 300) || `Local speech server returned ${res.status}.`);
    const body = (await res.json().catch(() => ({}))) as { text?: string };
    if (!body.text?.trim()) throw new Error("The local speech server returned no text.");
    return body.text.trim();
  }
  const bin = process.env.BOPS_WHISPER_BIN?.trim();
  const model = process.env.BOPS_WHISPER_MODEL?.trim();
  if (bin && model) return whisperFile(bin, model, audio);
  throw new Error("Voice transcription is unavailable offline. Set BOPS_LLM_TRANSCRIBE_URL to a local whisper server, or BOPS_WHISPER_BIN and BOPS_WHISPER_MODEL for whisper.cpp. Audio is not sent to a cloud.");
}

function whisperFile(bin: string, model: string, audio: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bops-speech-"));
  const file = join(dir, "clip.webm");
  writeFileSync(file, audio);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-m", model, "-f", file, "-nt", "-np"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      rmSync(dir, { recursive: true, force: true });
      reject(e);
    });
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0) reject(new Error(err.slice(0, 300) || `${bin} exited ${code}`));
      else resolve(out.trim());
    });
  });
}

/** Speak text on this Mac. No-op when `say` is not there. Never calls a cloud voice. */
export function speakLocal(text: string): Promise<void> {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!line || process.platform !== "darwin") return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn("say", [line], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}
