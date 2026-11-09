/**
 * Screenshot, ask a local vision model, run the actions, repeat.
 * If the model can't see the screen or won't name an action, the loop stops and says so.
 */
import { chat, type ToolDef } from "./provider";

export type ComputerAction = {
  type: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  button?: string;
  scroll_x?: number;
  scroll_y?: number;
  path?: { x: number; y: number }[];
};

const TOOL: ToolDef = {
  type: "function",
  function: {
    name: "computer",
    description: "Actions to take on the current screenshot. Use an empty actions list and say you are done when the task is finished.",
    parameters: { type: "object", properties: { actions: { type: "array" }, done: { type: "boolean" } } },
  },
};

export async function runComputerUseLoop(opts: {
  goal: string;
  maxSteps?: number;
  screenshot: () => Promise<{ mime: string; base64: string } | null>;
  act: (actions: ComputerAction[]) => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; steps: number; degraded?: string }> {
  const notes: string[] = [];
  let degraded: string | undefined;
  const max = opts.maxSteps ?? 8;
  for (let step = 1; step <= max; step++) {
    const shot = await opts.screenshot();
    if (!shot) {
      return { text: "This worker couldn't take a screenshot, so computer use stopped.", steps: step - 1, degraded: "no screenshot" };
    }
    let result;
    try {
      result = await chat({
        role: "vision",
        tools: [TOOL],
        fetchImpl: opts.fetchImpl,
        messages: [
          { role: "system", content: "You control a computer from screenshots. Call computer with the next actions, or with done true when the goal is finished. Coordinates are pixels of the screenshot." },
          {
            role: "user",
            content: [
              { type: "text", text: `Goal: ${opts.goal}\n${notes.length ? `So far: ${notes.join(" ")}` : ""}` },
              { type: "image_url", image_url: { url: `data:${shot.mime};base64,${shot.base64}` } },
            ],
          },
        ],
      });
    } catch (e) {
      return { text: `Computer use stopped: ${(e as Error).message}`, steps: step - 1, degraded: (e as Error).message };
    }
    if (result.degraded) degraded = result.degraded;
    const call = result.toolCalls.find((c) => c.name === "computer");
    if (!call) {
      return { text: result.content || "The vision model didn't return a computer action.", steps: step, degraded: degraded ?? "no computer action" };
    }
    let actions: ComputerAction[] = [];
    let done = false;
    try {
      const args = JSON.parse(call.arguments || "{}") as { actions?: ComputerAction[]; done?: boolean };
      actions = Array.isArray(args.actions) ? args.actions : [];
      done = args.done === true || actions.length === 0;
    } catch {
      return { text: "The vision model returned an action that wasn't valid JSON.", steps: step, degraded: "bad action json" };
    }
    if (done) return { text: result.content || "Done.", steps: step, degraded };
    const note = await opts.act(actions);
    notes.push(note);
  }
  return { text: "Stopped after the maximum number of computer-use steps.", steps: max, degraded };
}
