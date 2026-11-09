/**
 * OpenAI-compatible chat and embeddings against the configured local chain.
 * Talks to /v1 first, then the native Ollama routes older servers still use.
 */
import { authHeaders, originOf, withRole, type Attempt } from "./endpoints";
import { assertLocalModel, CloudModelError } from "./models";
import type { Role } from "./mode";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
export type ToolDef = { type: "function"; function: { name: string; description?: string; parameters?: unknown } };
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatResult = {
  model: string;
  endpoint: string;
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  degraded?: string;
};

const CHAT_MS = 180_000;

export async function chat(opts: {
  role: Role;
  messages: ChatMessage[];
  tools?: ToolDef[];
  preferModel?: string;
  fetchImpl?: typeof fetch;
}): Promise<ChatResult> {
  if (opts.preferModel) assertLocalModel(opts.preferModel);
  const hasImage = JSON.stringify(opts.messages).includes("image_url");
  const { value, attempt, skipped } = await withRole(
    opts.role,
    async (attempt) => complete(attempt, opts.messages, opts.tools ?? [], hasImage, opts.fetchImpl),
    { preferModel: opts.preferModel, fetchImpl: opts.fetchImpl },
  );
  return {
    ...value,
    model: attempt.model,
    endpoint: attempt.endpoint.id,
    ...(skipped.length ? { degraded: skipped.join(" | ") } : {}),
  };
}

async function complete(attempt: Attempt, messages: ChatMessage[], tools: ToolDef[], hasImage: boolean, fetchImpl: typeof fetch = fetch): Promise<Omit<ChatResult, "model" | "endpoint">> {
  assertLocalModel(attempt.model);
  const headers = { "Content-Type": "application/json", ...authHeaders(attempt.endpoint) };
  const base = attempt.endpoint.baseUrl.replace(/\/+$/, "");
  const body: Record<string, unknown> = { model: attempt.model, messages, temperature: 0.2 };
  if (tools.length) body.tools = tools;
  const res = await fetchImpl(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CHAT_MS) });
  let payload: unknown;
  if (res.status === 404 || res.status === 405) {
    payload = await nativeChat(attempt, messages, tools, headers, fetchImpl);
  } else if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    if (res.status === 404 || /not found|unknown model|does not exist/i.test(text)) throw new Error(text);
    if (hasImage && /image|vision|multimodal|image input/i.test(text)) throw new Error(text);
    if (tools.length && /tool|support|unimplemented|invalid/i.test(text)) {
      const bare = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: attempt.model, messages: withToolHint(messages, tools), temperature: 0.2 }),
        signal: AbortSignal.timeout(CHAT_MS),
      });
      if (!bare.ok) throw new Error((await bare.text()).slice(0, 500));
      payload = await bare.json();
      const parsed = fromOpenAI(payload);
      const loose = parsed.toolCalls.length ? parsed.toolCalls : looseToolCalls(parsed.content);
      return { ...parsed, toolCalls: loose, degraded: "This model didn't accept tool calls. Actions were read from its text." };
    }
    throw new Error(text);
  } else {
    payload = await res.json();
  }
  const parsed = fromOpenAI(payload);
  if (!parsed.toolCalls.length && tools.length) {
    const loose = looseToolCalls(parsed.content);
    if (loose.length) return { ...parsed, toolCalls: loose, degraded: "Tool calls were read from the model's text." };
  }
  return parsed;
}

async function nativeChat(attempt: Attempt, messages: ChatMessage[], tools: ToolDef[], headers: Record<string, string>, fetchImpl: typeof fetch) {
  const origin = originOf(attempt.endpoint.baseUrl);
  const nativeMessages = messages.map(toNative);
  const body: Record<string, unknown> = { model: attempt.model, messages: nativeMessages, stream: false };
  if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: t.function }));
  const res = await fetchImpl(`${origin}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_MS),
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 500));
  const json = (await res.json()) as { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; eval_count?: number; prompt_eval_count?: number };
  const calls = (json.message?.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call_${i + 1}`,
    name: String(c.function?.name || ""),
    arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
  }));
  return {
    choices: [
      {
        message: { content: json.message?.content ?? "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      },
    ],
    usage: { prompt_tokens: json.prompt_eval_count, completion_tokens: json.eval_count, total_tokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0) },
  };
}

function toNative(m: ChatMessage) {
  if (typeof m.content === "string" || m.content == null) return { role: m.role, content: m.content ?? "" };
  const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
  const images = m.content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")] : []));
  return { role: m.role, content: text, ...(images.length ? { images } : {}) };
}

function fromOpenAI(payload: unknown): Omit<ChatResult, "model" | "endpoint"> {
  const body = payload as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
    usage?: ChatResult["usage"];
    message?: { content?: string };
  };
  const message = (body.choices?.[0]?.message ?? body.message ?? {}) as { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] };
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls = (message.tool_calls ?? []).flatMap((c) => {
    const name = String(c.function?.name || "");
    if (!name) return [];
    const args = c.function?.arguments;
    return [{ id: c.id || `call_${name}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }];
  });
  return { content, toolCalls, usage: body.usage };
}

function withToolHint(messages: ChatMessage[], tools: ToolDef[]): ChatMessage[] {
  const names = tools.map((t) => t.function.name).join(", ");
  const hint = `If you need a tool (${names}), reply with JSON only: {"tool":"<name>","arguments":{...}}`;
  return [{ role: "system", content: hint }, ...messages];
}

/** A model that can't call tools sometimes still prints a JSON action. */
export function looseToolCalls(text: string): ToolCall[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const json = JSON.parse(match[0]) as { tool?: string; name?: string; arguments?: unknown; actions?: unknown };
    if (Array.isArray(json.actions)) return [{ id: "call_loose", name: "computer", arguments: JSON.stringify({ actions: json.actions }) }];
    const name = json.tool || json.name;
    if (!name) return [];
    return [{ id: "call_loose", name, arguments: JSON.stringify(json.arguments ?? {}) }];
  } catch {
    return [];
  }
}

export async function embed(texts: string[], fetchImpl: typeof fetch = fetch): Promise<number[][]> {
  const clean = texts.map((t) => t.slice(0, 8000));
  const { value } = await withRole("embed", (attempt) => embedOn(attempt, clean, fetchImpl), { fetchImpl });
  return value;
}

async function embedOn(attempt: Attempt, texts: string[], fetchImpl: typeof fetch): Promise<number[][]> {
  assertLocalModel(attempt.model);
  const headers = { "Content-Type": "application/json", ...authHeaders(attempt.endpoint) };
  const base = attempt.endpoint.baseUrl.replace(/\/+$/, "");
  const origin = originOf(attempt.endpoint.baseUrl);
  const openai = await fetchImpl(`${base}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: attempt.model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (openai.ok) {
    const json = (await openai.json()) as { data?: { embedding?: number[]; index?: number }[] };
    const rows = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length === texts.length && rows.every((r) => Array.isArray(r.embedding))) return rows.map((r) => r.embedding as number[]);
  }
  const batch = await fetchImpl(`${origin}/api/embed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: attempt.model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (batch.ok) {
    const json = (await batch.json()) as { embeddings?: number[][] };
    if (Array.isArray(json.embeddings) && json.embeddings.length === texts.length) return json.embeddings;
  }
  const out: number[][] = [];
  for (const prompt of texts) {
    const one = await fetchImpl(`${origin}/api/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: attempt.model, prompt }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!one.ok) throw new Error((await one.text()).slice(0, 300));
    const json = (await one.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) throw new Error(`${attempt.model} returned no embedding`);
    out.push(json.embedding);
  }
  return out;
}

export { CloudModelError };
