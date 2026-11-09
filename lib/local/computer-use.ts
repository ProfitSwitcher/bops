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
  keys?: string[] | null;
  button?: string;
  scroll_x?: number;
  scroll_y?: number;
  path?: { x: number; y: number }[];
};

const TOOL: ToolDef = {
  type: "function",
  function: {
    name: "computer",
    description: "Actions on the current screenshot. When the goal is finished, set done true in this same call, together with the final action if one is still needed.",
    parameters: { type: "object", properties: { actions: { type: "array" }, done: { type: "boolean" } } },
  },
};

export function computerMaxSteps(): number {
  const n = Number(process.env.BOPS_COMPUTER_MAX_STEPS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25;
}

export async function runComputerUseLoop(opts: {
  goal: string;
  maxSteps?: number;
  screenshot: () => Promise<{ mime: string; base64: string } | null>;
  act: (actions: ComputerAction[]) => Promise<string>;
  onStep?: (action: ComputerAction) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; steps: number; degraded?: string }> {
  const notes: string[] = [];
  let degraded: string | undefined;
  let last = "";
  const max = opts.maxSteps ?? computerMaxSteps();
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
          {
            role: "system",
            content:
              "You control a computer from screenshots. Call computer with the next actions. When the goal is finished, set done true in that same call, including the final action if one is still needed. Do not repeat an action that already ran. Coordinates are pixels of the screenshot.",
          },
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
      done = args.done === true;
    } catch {
      return { text: "The vision model returned an action that wasn't valid JSON.", steps: step, degraded: "bad action json" };
    }
    if (!actions.length) return { text: result.content || "Done.", steps: step, degraded };
    const signature = JSON.stringify(actions);
    if (signature === last) return { text: result.content || "Stopped: the same action repeated.", steps: step - 1, degraded: "repeated action" };
    last = signature;
    const note = await opts.act(actions);
    for (const action of actions) opts.onStep?.(action);
    notes.push(note);
    if (done) return { text: result.content || "Done.", steps: step, degraded };
  }
  return { text: "Stopped after the maximum number of computer-use steps.", steps: max, degraded: "max steps" };
}
