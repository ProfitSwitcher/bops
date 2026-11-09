import "server-only";
import { toFile } from "openai";
import { localOnly } from "@/lib/local/mode";
import { openaiClient } from "./openai-client";
import { getState } from "./store";
import { usageTags } from "./usage";

/**
 * The chat's mic: what the user said, as text for the composer (they read it, then send it). One
 * gpt-transcribe call per recording, told the names it may hear (the user's, their bots') so they're
 * spelled right. Through Bops Cloud its seconds are counted for the bot the chat is with.
 */

const client = openaiClient();
const MODEL = "gpt-transcribe";
/**
 * OpenAI takes up to 25 MB, but Next passes on only the first 10 MB of a request (proxyClientMaxBodySize).
 * Five minutes of speech (the mic's longest) is about 2 MB.
 */
export const MAX_RECORDING = 9 * 1024 * 1024;

export async function transcribe(audio: Blob, botId?: string): Promise<string> {
  if (localOnly() && !process.env.BOPS_LLM_TRANSCRIBE_MODEL?.trim()) throw new Error("Voice transcription is unavailable offline. Set BOPS_LLM_TRANSCRIBE_MODEL to a local speech model.");
  const names = [getState().owner?.name.trim(), ...getState().bots.map((b) => b.name)].filter(Boolean);
  const ext = /mp4|m4a|aac/.test(audio.type) ? "m4a" : /ogg/.test(audio.type) ? "ogg" : /wav/.test(audio.type) ? "wav" : "webm";
  const file = await toFile(audio, `recording.${ext}`, { type: audio.type || "audio/webm" });
  const r = await client.audio.transcriptions.create(
    { model: MODEL, file, prompt: `A message typed into Bops, a chat app with AI bots. Names that may come up: ${[...new Set(names)].join(", ")}.` },
    usageTags("chat", botId),
  );
  return r.text.trim();
}
