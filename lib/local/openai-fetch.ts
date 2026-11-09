/**
 * Fetch implementation for the OpenAI SDK. Responses, chat, and embeddings are
 * handled locally. Image, realtime, and any public host are refused.
 */
import { assertLocalHost } from "./egress.mjs";
import { runResponses, type ResponseBody } from "./responses";
import { embed } from "./provider";
import { localOnly } from "./mode";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function localOpenAIFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!localOnly()) return fetch(input as RequestInfo, init);
  const url = new URL(urlOf(input), "http://127.0.0.1");
  const path = url.pathname;
  if (path.endsWith("/responses")) return json(await responsesJson(init));
  if (path.endsWith("/embeddings")) return json(await embeddingsJson(init));
  if (path.includes("/images") || path.includes("/realtime") || path.includes("/audio/speech")) {
    return json({ error: { message: "That OpenAI feature is unavailable offline.", type: "local_only" } }, 400);
  }
  if (path.includes("/audio/transcriptions")) return transcribe();
  try {
    assertLocalHost(url.hostname);
  } catch (e) {
    return json({ error: { message: (e as Error).message, type: "local_only" } }, 403);
  }
  return fetch(input as RequestInfo, init);
}

async function responsesJson(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as ResponseBody;
  const response = await runResponses(body);
  if (!body.stream) return response;
  const text = response.output_text || "";
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function embeddingsJson(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
  const input = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
  const vectors = await embed(input);
  return { data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })), model: "local" };
}

async function transcribe(): Promise<Response> {
  const model = process.env.BOPS_LLM_TRANSCRIBE_MODEL?.trim();
  if (!model) return json({ error: { message: "Voice transcription is unavailable offline. Set BOPS_LLM_TRANSCRIBE_MODEL to a local speech model.", type: "local_only" } }, 400);
  return json({ error: { message: `A local speech model (${model}) is configured, but this fork does not upload audio to a cloud. Point a local speech server at BOPS_LLM_TRANSCRIBE_URL to finish this path.`, type: "local_only" } }, 501);
}

function json(body: unknown, status = 200): Response {
  if (body instanceof Response) return body;
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
