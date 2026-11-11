/**
 * Local tasks that do not need the screen: a shell command, or a chat reply.
 * Screen work (a browser, a click) still goes through the computer loop.
 */
import { chat } from "./provider";
import { commandNeedsApproval, runLocalShell } from "./shell";

const SCREEN = /\b(click|browser|chrome|safari|website|web ?page|sign[\s-]?in|log[\s-]?in|scroll|screenshot|on the screen|mouse|pointer|fill (?:out |in )?(?:a |the )?form)\b/i;

export function needsScreen(goal: string): boolean {
  return SCREEN.test(goal);
}

/** A single shell command written in the goal, when the job is that command. */
export function commandOf(goal: string): string | null {
  const fence = goal.match(/`([^`\n]{1,200})`/);
  if (fence) return fence[1].trim();
  const line = goal.trim().split("\n")[0]?.trim() ?? "";
  if (line.length > 240 || /\s{2,}/.test(line)) return null;
  if (/^(?:brew|ollama|hermes|git|npm|pnpm|yarn|curl|python3?|node|bash|sh)\b/.test(line)) return line;
  return null;
}

/** Run a command, or answer in chat with run_command available. Never the screen. */
export async function localChatTask(goal: string, botId: string): Promise<string> {
  const command = commandOf(goal);
  if (command) return runCommand(command, botId);
  const result = await chat({
    role: "planner",
    timeoutMs: 60_000,
    messages: [
      {
        role: "system",
        content: "You are on this Mac. Do the job in the user message. If it needs a shell command, call run_command once. Reply with the result in a few sentences. Never say you lack access to this machine.",
      },
      { role: "user", content: goal.slice(0, 4000) },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run one shell command on this Mac.",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      },
    ],
  });
  const call = result.toolCalls.find((c) => c.name === "run_command");
  if (!call) return result.content.trim() || "Done.";
  let asked = "";
  try {
    asked = String(JSON.parse(call.arguments).command ?? "");
  } catch {
    asked = "";
  }
  if (!asked.trim()) return result.content.trim() || "Done.";
  const output = await runCommand(asked, botId);
  return [result.content.trim(), output].filter(Boolean).join("\n");
}

async function runCommand(command: string, botId: string): Promise<string> {
  const why = commandNeedsApproval(command);
  if (why) return `Not run. It needs approval in the chat (${why}): ${command}`;
  const ran = await runLocalShell({ command, botId });
  const output = ran.output.trim();
  return output || `exit ${ran.exitCode}`;
}
