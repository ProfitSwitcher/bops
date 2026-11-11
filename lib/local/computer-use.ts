/**
 * Screenshot, ask a local vision model, run the actions, repeat.
 * If the model can't see the screen or won't name an action, the loop stops and says so.
 */
import { fitPng, scaleCoord, SENT_WIDTH } from "./png-fit";
import { chat, type ToolDef } from "./provider";

export const ACTION_TYPES = ["click", "double_click", "move", "type", "key", "scroll", "drag", "wait", "screenshot"] as const;

export function scaleAction<T extends ComputerAction>(action: T, screenW: number, sentW: number): T {
  const s = (v?: number) => scaleCoord(v, screenW, sentW);
  return {
    ...action,
    x: s(action.x),
    y: s(action.y),
    scroll_x: s(action.scroll_x),
    scroll_y: s(action.scroll_y),
    path: action.path?.map((p) => ({ x: s(p.x) ?? p.x, y: s(p.y) ?? p.y })),
  };
}

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
    description: `Actions on the current screenshot. type is one of: ${ACTION_TYPES.join(", ")}. When the goal is finished, set done true in this same call and write the answer the user asked for in the message (what is on screen), not only the word Done.`,
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...ACTION_TYPES] },
              x: { type: "number" },
              y: { type: "number" },
              text: { type: "string" },
              keys: { type: "array", items: { type: "string" } },
            },
            required: ["type"],
          },
        },
        done: { type: "boolean" },
      },
    },
  },
};

function resultText(content: string, notes: string[], goal: string): string {
  const said = content.trim();
  if (said && !/^done\.?$/i.test(said)) return said;
  if (notes.length) return `${notes.join("; ")}.`;
  return `I couldn't answer "${goal.slice(0, 160)}" from the screen.`;
}

export function computerMaxSteps(): number {
  const n = Number(process.env.BOPS_COMPUTER_MAX_STEPS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25;
}

function fitScreenshot(shot: { mime: string; base64: string; width?: number; height?: number }) {
  const bytes = Buffer.from(shot.base64, "base64");
  const fit = fitPng(bytes, SENT_WIDTH);
  if (fit) return { mime: "image/png", base64: fit.png.toString("base64"), screenW: fit.screenW, screenH: fit.screenH, sentW: fit.sentW, sentH: fit.sentH };
  const screenW = shot.width || SENT_WIDTH;
  const screenH = shot.height || Math.max(1, Math.round((screenW * 9) / 16));
  const sentW = screenW > SENT_WIDTH ? SENT_WIDTH : screenW;
  const sentH = screenW > SENT_WIDTH ? Math.max(1, Math.round((screenH * sentW) / screenW)) : screenH;
  return { mime: shot.mime, base64: shot.base64, screenW, screenH, sentW, sentH };
}

export async function runComputerUseLoop(opts: {
  goal: string;
  maxSteps?: number;
  screenshot: () => Promise<{ mime: string; base64: string; width?: number; height?: number; locked?: boolean } | null>;
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
    if (shot.locked) return { text: "This Mac's screen is locked; unlock it to run screen tasks.", steps: step - 1, degraded: "locked" };
    const fitted = fitScreenshot(shot);
    let result;
    try {
      result = await chat({
        role: "vision",
        tools: [TOOL],
        fetchImpl: opts.fetchImpl,
        messages: [
          {
            role: "system",
            content: `You control a computer from screenshots. The image is ${fitted.sentW} by ${fitted.sentH} pixels. Give coordinates in that image. Call computer with the next actions. type must be one of: ${ACTION_TYPES.join(", ")}. mouse_move is move, left_click is click. Do not open Terminal.app or click to type a shell command. Shell commands are run by the chat tool run_command, not by clicking. When the goal is finished, set done true in that same call, including the final action if one is still needed, and write the result the user asked for (what is on screen, which app is frontmost). Do not answer with only Done. Do not repeat an action that already ran.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: `Goal: ${opts.goal}\nThe screenshot is ${fitted.sentW}×${fitted.sentH} pixels.\n${notes.length ? `So far: ${notes.join(" ")}` : ""}` },
              { type: "image_url", image_url: { url: `data:${fitted.mime};base64,${fitted.base64}` } },
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
    if (!actions.length) return { text: resultText(result.content, notes, opts.goal), steps: step, degraded };
    const signature = JSON.stringify(actions);
    if (signature === last) {
      const look = await chat({
        role: "vision",
        fetchImpl: opts.fetchImpl,
        messages: [
          { role: "system", content: "Answer the user's goal from this screenshot in one or two sentences. Describe what is on the screen. Do not call tools." },
          {
            role: "user",
            content: [
              { type: "text", text: `Goal: ${opts.goal}` },
              { type: "image_url", image_url: { url: `data:${fitted.mime};base64,${fitted.base64}` } },
            ],
          },
        ],
      }).catch(() => null);
      const said = look?.content?.trim();
      return { text: said && !/^done\.?$/i.test(said) ? said : resultText(result.content, notes, opts.goal), steps: step - 1, degraded: "repeated action" };
    }
    last = signature;
    const scaled = actions.map((a) => scaleAction(a, fitted.screenW, fitted.sentW));
    const note = await opts.act(scaled);
    notes.push(note);
    if (/Unknown action/.test(note)) continue;
    for (const action of scaled) opts.onStep?.(action);
    if (done) return { text: resultText(result.content, notes, opts.goal), steps: step, degraded };
  }
  return { text: "Stopped after the maximum number of computer-use steps.", steps: max, degraded: "max steps" };
}
