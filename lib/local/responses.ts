/**
 * The Responses API shape this app already speaks, answered by a local chat model.
 * Computer actions are handed back to the app. Web search is answered here: it is
 * unavailable offline, and the model is told that instead of calling a search API.
 */
import { randomUUID } from "node:crypto";
import { chat, looseToolCalls, type ChatMessage, type ToolDef } from "./provider";
import { roleChain, type Role } from "./mode";
import { isCloudModel } from "./models";

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
};

export function roleFor(body: ResponseBody): Role {
  const tools = body.tools ?? [];
  const blob = JSON.stringify(body.input ?? "");
  if (tools.some((t) => t.type === "computer") || /input_image|image_url|computer_screenshot/.test(blob)) return "vision";
  const effort = body.reasoning?.effort;
  if (effort === "high" || effort === "xhigh" || effort === "max") return "heavy";
  if (body.model && roleChain("heavy").some((s) => s.model.toLowerCase() === body.model!.toLowerCase())) return "heavy";
  if (effort === "none") return "fast";
  if (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0 && body.max_output_tokens <= 1500 && !tools.length) return "fast";
  return "planner";
}

export async function runResponses(body: ResponseBody, fetchImpl?: typeof fetch) {
  const role = roleFor(body);
  const prefer = body.model && !isCloudModel(body.model) && !/^gpt-|^(o1|o3|o4)/.test(body.model) ? body.model : undefined;
  let messages = restore(body);
  const tools = toTools(body.tools ?? []);
  let result = await chat({ role, messages, tools, preferModel: prefer, fetchImpl });
  let guard = 0;
  while (guard++ < 2 && result.toolCalls.length && result.toolCalls.every((c) => c.name === "web_search")) {
    messages = [
      ...messages,
      { role: "assistant", content: result.content || null, tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) },
      ...result.toolCalls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "Web search is unavailable offline. Say so, and answer from what you already know." })),
    ];
    result = await chat({ role, messages, tools, preferModel: result.model, fetchImpl });
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
  return {
    id,
    object: "response",
    model: result.model,
    status: "completed",
    output,
    output_text: text,
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
    const role = rec.role === "assistant" || rec.role === "system" ? rec.role : "user";
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
          description: "Look something up on the public web. Offline, this only reports that search is unavailable.",
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
