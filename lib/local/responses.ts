/**
 * The Responses API shape this app already speaks, answered by a local chat model.
 * Computer actions are handed back to the app. Web search is answered here: offline
 * it reports that search is unavailable; when BOPS_ALLOW_EGRESS=1 it searches the web.
 */
import { randomUUID } from "node:crypto";
import { chat, looseToolCalls, type ChatMessage, type ToolDef } from "./provider";
import { allowEgress, roleChain, type Role } from "./mode";
import { isCloudModel } from "./models";
import { webSearch } from "./web-search";

type Store = Map<string, ChatMessage[]>;
const g = globalThis as unknown as { bopsLocalResponses?: Store };
const history: Store = (g.bopsLocalResponses ??= new Map());
const routes = new Map<string, { model: string; endpoint: string; cloud?: true }>();

/** Which model and endpoint produced a Responses id. The OpenAI SDK drops unknown fields, so this is kept here. */
export function answerRoute(id: string | undefined) {
  return id ? routes.get(id) : undefined;
}

export type ResponseBody = {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
  previous_response_id?: string;
  stream?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string };
  text?: { format?: { type?: string; name?: string; schema?: Record<string, unknown>; strict?: boolean } };
};

/** True only when the newest user message itself carries an image. An earlier picture does not. */
export function latestUserHasImage(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "computer_call_output") return true;
    if (rec.type === "function_call" || rec.type === "computer_call" || rec.type === "reasoning" || rec.type === "compaction_trigger" || rec.type === "function_call_output") continue;
    if (rec.role === "assistant" || rec.role === "system" || rec.role === "developer") continue;
    return messageHasImage(rec.content ?? rec);
  }
  return false;
}

function messageHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: string }).type;
    return type === "input_image" || type === "image_url" || type === "computer_screenshot";
  });
}

export function roleFor(body: ResponseBody): Role {
  const tools = body.tools ?? [];
  if (tools.some((t) => t.type === "computer") || latestUserHasImage(body.input)) return "vision";
  const effort = body.reasoning?.effort;
  if (effort === "high" || effort === "xhigh" || effort === "max") return "heavy";
  if (body.model && roleChain("heavy").some((s) => s.model.toLowerCase() === body.model!.toLowerCase())) return "heavy";
  if (effort === "none") return "fast";
  if (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0 && body.max_output_tokens <= 1500 && !tools.length) return "fast";
  return "planner";
}

function hasImage(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((p) => p.type === "image_url");
}

/**
 * An image is sent only with the newest user message. A later text question drops earlier
 * pictures so they are not what the model answers. When that newest message does carry one,
 * it stays last, after status notes.
 */
export function focusLatestImage(messages: ChatMessage[]): ChatMessage[] {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
  if (lastUser < 0 || !hasImage(messages[lastUser])) {
    return messages.map((message) => {
      if (!hasImage(message) || !Array.isArray(message.content)) return message;
      const text = message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      return { ...message, content: text };
    });
  }
  if (lastUser === messages.length - 1) return messages;
  const image = messages[lastUser];
  return [
    ...messages.slice(0, lastUser),
    ...messages.slice(lastUser + 1),
    { role: "system", content: "The next message is the latest one. Answer it, and look at its image. Earlier messages are context only." },
    image,
  ];
}

export function stripJsonFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

async function webSearchResult(args: string | undefined, fetchImpl?: typeof fetch): Promise<string> {
  if (!allowEgress()) return "Web search is unavailable offline. Say so, and answer from what you already know.";
  let query = "";
  try {
    const parsed = JSON.parse(args || "{}") as { query?: unknown };
    query = typeof parsed.query === "string" ? parsed.query : "";
  } catch {
    query = "";
  }
  return webSearch(query, fetchImpl ?? fetch);
}

function schemaOf(body: ResponseBody): Record<string, unknown> | undefined {

  const format = body.text?.format;
  if (!format) return undefined;
  if (format.type === "json_schema" && format.schema && typeof format.schema === "object") return format.schema;
  if (format.type === "json_object") return { type: "object" };
  return undefined;
}

export async function runResponses(body: ResponseBody, fetchImpl?: typeof fetch) {
  const role = roleFor(body);
  const prefer = body.model && !isCloudModel(body.model) && !/^gpt-|^(o1|o3|o4)/.test(body.model) ? body.model : undefined;
  let messages = focusLatestImage(restore(body));
  const tools = toTools(body.tools ?? []);
  const jsonSchema = schemaOf(body);
  let result = await chat({ role, messages, tools, preferModel: prefer, jsonSchema, fetchImpl });
  let guard = 0;
  while (guard++ < 2 && result.toolCalls.length && result.toolCalls.every((c) => c.name === "web_search")) {
    const toolMessages = await Promise.all(
      result.toolCalls.map(async (c) => ({
        role: "tool" as const,
        tool_call_id: c.id,
        content: await webSearchResult(c.arguments, fetchImpl),
      })),
    );
    messages = [
      ...messages,
      { role: "assistant", content: result.content || null, tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) },
      ...toolMessages,
    ];
    result = await chat({ role, messages, tools, preferModel: result.model, jsonSchema, fetchImpl });
  }
  const id = `resp_${randomUUID()}`;
  const output = toOutput(result);
  const stored: ChatMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: result.content || null,
      ...(result.toolCalls.length
        ? { tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    },
  ];
  history.set(id, stored.slice(-40));
  routes.set(id, { model: result.model, endpoint: result.endpoint, ...(result.cloud ? { cloud: true as const } : {}) });
  if (routes.size > 200) routes.delete(routes.keys().next().value as string);
  if (history.size > 200) history.delete(history.keys().next().value as string);
  const text = output
    .filter((o) => o.type === "message")
    .flatMap((o) => {
      const content = o.content;
      return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text ?? "") : "")) : [];
    })
    .join("\n")
    .trim();
  const clean = stripJsonFence(text);
  return {
    id,
    object: "response",
    model: result.model,
    status: "completed",
    output: output.map((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) return item;
      return { ...item, content: item.content.map((part) => (part && typeof part === "object" && "text" in part ? { ...part, text: stripJsonFence(String(part.text ?? "")) } : part)) };
    }),
    output_text: clean,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
    endpoint: result.endpoint,
    ...(result.degraded ? { local_note: result.degraded } : {}),
  };
}

function restore(body: ResponseBody): ChatMessage[] {
  const prev = body.previous_response_id ? history.get(body.previous_response_id) ?? [] : [];
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  messages.push(...prev.filter((m) => m.role !== "system"));
  messages.push(...inputMessages(body.input));
  return messages;
}

function inputMessages(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "function_call_output") {
      out.push({ role: "tool", tool_call_id: String(rec.call_id ?? ""), content: typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? "") });
      continue;
    }
    if (rec.type === "computer_call_output") {
      out.push({ role: "user", content: imageContent(rec.output) });
      continue;
    }
    if (rec.type === "function_call" || rec.type === "computer_call" || rec.type === "reasoning" || rec.type === "compaction_trigger") continue;
    const role = rec.role === "assistant" ? "assistant" : rec.role === "system" || rec.role === "developer" ? "system" : "user";
    out.push({ role, content: contentOf(rec.content ?? rec) });
  }
  return out;
}

function contentOf(content: unknown): ChatMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: { type: "text"; text: string }[] | { type: "image_url"; image_url: { url: string } }[] = [];
  const mixed: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") mixed.push({ type: "text", text: String(p.text ?? "") });
    else if (p.type === "input_image" || p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : String((p.image_url as { url?: string } | undefined)?.url ?? "");
      if (url) mixed.push({ type: "image_url", image_url: { url } });
    }
  }
  void parts;
  if (!mixed.length) return "";
  if (mixed.every((p) => p.type === "text")) return mixed.map((p) => (p as { text: string }).text).join("\n");
  return mixed;
}

function imageContent(output: unknown): ChatMessage["content"] {
  const shot = output && typeof output === "object" ? (output as { image_url?: string; type?: string }) : undefined;
  if (shot?.image_url) return [{ type: "text", text: "The screen now:" }, { type: "image_url", image_url: { url: shot.image_url } }];
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? "");
}

function toTools(tools: NonNullable<ResponseBody["tools"]>): ToolDef[] {
  const out: ToolDef[] = [];
  for (const tool of tools) {
    if (tool.type === "computer") {
      out.push({
        type: "function",
        function: {
          name: "computer",
          description: "Look at the screen and act. Pass one or more actions. You will be shown the screen again after they run.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", description: "click, double_click, type, keypress, scroll, move, drag, wait, or screenshot" },
                    x: { type: "number" },
                    y: { type: "number" },
                    text: { type: "string" },
                    keys: { type: "array", items: { type: "string" } },
                    button: { type: "string" },
                    scroll_x: { type: "number" },
                    scroll_y: { type: "number" },
                  },
                  required: ["type"],
                },
              },
            },
            required: ["actions"],
          },
        },
      });
    } else if (tool.type === "web_search") {
      out.push({
        type: "function",
        function: {
          name: "web_search",
          description: allowEgress()
            ? "Look something up on the public web. Returns titles, URLs, and short snippets."
            : "Look something up on the public web. Offline, this only reports that search is unavailable.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      });
    } else if (tool.type === "function" && tool.name) {
      out.push({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } });
    }
  }
  return out;
}

function toOutput(result: { content: string; toolCalls: { id: string; name: string; arguments: string }[] }) {
  const output: Record<string, unknown>[] = [];
  if (result.content && !result.toolCalls.length) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: result.content, annotations: [] }],
    });
  }
  for (const call of result.toolCalls) {
    if (call.name === "computer") {
      let actions: unknown[] = [];
      try {
        const args = JSON.parse(call.arguments || "{}") as { actions?: unknown[]; action?: unknown };
        actions = Array.isArray(args.actions) ? args.actions : args.action ? [args.action] : [];
      } catch {
        actions = looseToolCalls(call.arguments).length ? [] : [];
      }
      output.push({ type: "computer_call", id: `cu_${call.id}`, call_id: call.id, actions, status: "completed" });
    } else if (call.name !== "web_search") {
      output.push({ type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments || "{}", status: "completed" });
    }
  }
  if (!output.length) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: result.content || "Done.", annotations: [] }],
    });
  }
  return output;
}

export function resetResponsesForTests() {
  history.clear();
}
