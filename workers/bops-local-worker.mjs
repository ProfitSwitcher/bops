/**
 * Local computer worker. Binds to loopback unless BOPS_WORKER_BIND is a LAN address.
 * Never binds 0.0.0.0. Native screen control on macOS, Windows, and Linux; fake mode for tests.
 *
 *   BOPS_WORKER_BIND=127.0.0.1 BOPS_WORKER_PORT=8791 BOPS_WORKER_TOKEN=... node workers/bops-local-worker.mjs
 */
import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export function refuseBind(bind) {
  if (!bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]") return "Refusing to listen on every interface. Set BOPS_WORKER_BIND to 127.0.0.1 or one LAN address.";
  if (net.isIP(bind) && !isLocal(bind)) return `Refusing to listen on ${bind}. It is not a LAN or loopback address.`;
  return "";
}

function isLocal(ip) {
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return false;
  const [a, b] = p;
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function authorized(req, token, loopbackOnly) {
  if (loopbackOnly && !token) return true;
  const header = req.headers.authorization || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !got || got.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

export function startWorker(opts = {}) {
  const bind = opts.bind ?? process.env.BOPS_WORKER_BIND ?? "127.0.0.1";
  const why = refuseBind(bind);
  if (why) throw new Error(why);
  const token = opts.token ?? process.env.BOPS_WORKER_TOKEN ?? "";
  const loopbackOnly = bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
  if (!loopbackOnly && !token) throw new Error("A LAN worker needs BOPS_WORKER_TOKEN.");
  const kind = opts.kind ?? process.env.BOPS_WORKER_KIND ?? "native";
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") return send(res, 200, { ok: true, kind });
      if (!authorized(req, token, loopbackOnly)) return send(res, 401, { error: "Unauthorized" });
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJson(req);
        const id = randomUUID();
        sessions.set(id, { name: body.name || "Bops", actions: [] });
        return send(res, 200, { id, name: body.name || "Bops", status: "running" });
      }
      const session = url.pathname.match(/^\/v1\/sessions\/([^/]+)(.*)$/);
      if (!session) return send(res, 404, { error: "Not found" });
      const id = session[1];
      const rest = session[2] || "";
      const current = sessions.get(id);
      if (!current) return send(res, 404, { error: "No such session" });
      if (req.method === "GET" && rest === "") return send(res, 200, { id, name: current.name, status: "running" });
      if (req.method === "DELETE" && rest === "") {
        sessions.delete(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && rest === "/screenshot") {
        const bytes = kind === "fake" ? PNG : await screenshot();
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && ["/click", "/type", "/key", "/bash", "/scroll", "/move"].includes(rest)) {
        const body = await readJson(req);
        current.actions.push({ op: rest.slice(1), body });
        if (kind === "fake") return send(res, 200, { ok: true, output: rest === "/bash" ? "ok" : "", exit_code: 0 });
        const output = await act(rest, body);
        return send(res, 200, { ok: true, output, exit_code: 0 });
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  const port = opts.port ?? Number(process.env.BOPS_WORKER_PORT || 8791);
  return new Promise((resolve) => {
    server.listen(port, bind, () => resolve({ server, port: server.address().port, bind, sessions }));
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function screenshot() {
  const dir = mkdtempSync(join(tmpdir(), "bops-shot-"));
  const file = join(dir, "screen.png");
  try {
    if (process.platform === "darwin") await run("screencapture", ["-x", file]);
    else if (process.platform === "win32") await run("powershell", ["-NoProfile", "-Command", windowsShot(file)]);
    else await run("import", ["-window", "root", file]).catch(() => run("gnome-screenshot", ["-f", file]));
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function windowsShot(file) {
  const path = file.replace(/\\/g, "\\\\");
  return `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${path}'); $g.Dispose(); $bmp.Dispose()`;
}

async function act(op, body) {
  if (process.platform === "darwin") return macAct(op, body);
  if (process.platform === "win32") return windowsAct(op, body);
  return linuxAct(op, body);
}

async function macAct(op, body) {
  if (op === "/bash") return (await run("bash", ["-lc", String(body.command || "true")])).stdout;
  if (op === "/type") return (await run("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(String(body.text || ""))}`])).stdout;
  if (op === "/key") return (await run("osascript", ["-e", macKeyScript(keyInput(body))])).stdout;
  if (op === "/move" || op === "/scroll") return (await run("osascript", ["-l", "JavaScript", "-e", macPointerScript(op, body)])).stdout;
  if (op === "/click") {
    const x = Math.round(Number(body.x) || 0);
    const y = Math.round(Number(body.y) || 0);
    const clicks = body.double ? 2 : 1;
    return (await run("osascript", ["-e", `tell application "System Events" to click at {${x}, ${y}}`, ...(clicks === 2 ? ["-e", `tell application "System Events" to click at {${x}, ${y}}`] : [])])).stdout;
  }
  return "";
}

/** US virtual key codes System Events understands. Named keys must not be typed as the word itself. */
const MAC_KEY_CODES = {
  return: 36, enter: 36, tab: 48, escape: 53, esc: 53,
  delete: 51, backspace: 51, forwarddelete: 117, del: 117,
  left: 123, arrowleft: 123, leftarrow: 123,
  right: 124, arrowright: 124, rightarrow: 124,
  down: 125, arrowdown: 125, downarrow: 125,
  up: 126, arrowup: 126, uparrow: 126,
  space: 49, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
};
const MAC_MODIFIERS = { cmd: "command", command: "command", meta: "command", super: "command", ctrl: "control", control: "control", alt: "option", option: "option", opt: "option", shift: "shift" };

function keyInput(body) {
  if (Array.isArray(body?.keys) && body.keys.length) return body.keys.map(String).join("+");
  if (Array.isArray(body?.modifiers) && body?.key) return [...body.modifiers, body.key].map(String).join("+");
  return String(body?.key || "");
}

/** `{ code, modifiers }` for a key name or a combo such as ctrl+shift+Tab. `code` is null when it is not a named key. */
export function macKeyPlan(input) {
  const raw = String(input || "").trim();
  const parts = raw === "+" ? ["+"] : raw.split("+").map((s) => s.trim()).filter(Boolean);
  const modifiers = [];
  const keys = [];
  for (const part of parts) {
    const mod = MAC_MODIFIERS[part.toLowerCase()];
    if (mod && !keys.length) modifiers.push(mod);
    else keys.push(part);
  }
  const name = keys.length === 1 ? keys[0] : "";
  const code = name ? MAC_KEY_CODES[name.toLowerCase()] : undefined;
  return { code: code === undefined ? null : code, modifiers: [...new Set(modifiers)] };
}

/** System Events `key code` with `using {command down, …}`. A single typed character stays a keystroke. */
export function macKeyScript(input) {
  const plan = macKeyPlan(input);
  if (plan.code == null) {
    const text = String(input || "");
    if ([...text].length === 1) return `tell application "System Events" to keystroke ${JSON.stringify(text)}`;
    throw new Error(`Unknown key ${JSON.stringify(text)}`);
  }
  const using = plan.modifiers.length ? ` using {${plan.modifiers.map((m) => `${m} down`).join(", ")}}` : "";
  return `tell application "System Events" to key code ${plan.code}${using}`;
}

/**
 * Move and scroll via CoreGraphics. JXA posts CGEventCreateMouseEvent / CGEventCreateScrollWheelEvent.
 * Positive scroll_y moves the page down (the wheel value is negated; CoreGraphics treats positive as up).
 */
export function macPointerScript(op, body) {
  const x = Math.round(Number(body?.x) || 0);
  const y = Math.round(Number(body?.y) || 0);
  const move = `ObjC.import("CoreGraphics");
const src = $.CGEventSourceCreate(1);
const p = $.CGPointMake(${x}, ${y});
const moved = $.CGEventCreateMouseEvent(src, 5, p, 0);
$.CGEventPost(0, moved);`;
  if (op === "/move") return move;
  const dy = Math.round(Number(body?.scroll_y ?? body?.dy ?? body?.deltaY) || 0);
  const dx = Math.round(Number(body?.scroll_x ?? body?.dx ?? body?.deltaX) || 0);
  return `${move}
const wheel = $.CGEventCreateScrollWheelEvent(src, 0, 2, ${-dy}, ${dx});
$.CGEventPost(0, wheel);`;
}

async function linuxAct(op, body) {
  if (op === "/bash") return (await run("bash", ["-lc", String(body.command || "true")])).stdout;
  if (op === "/click") return (await run("xdotool", ["mousemove", String(Math.round(body.x || 0)), String(Math.round(body.y || 0)), "click", ...(body.double ? ["--repeat", "2", "1"] : ["1"])])).stdout;
  if (op === "/type") return (await run("xdotool", ["type", "--", String(body.text || "")])).stdout;
  if (op === "/key") return (await run("xdotool", ["key", "--", String(body.key || "Return")])).stdout;
  return "";
}

async function windowsAct(op, body) {
  if (op === "/bash") return (await run("powershell", ["-NoProfile", "-Command", String(body.command || "Write-Output ok")])).stdout;
  const script =
    op === "/click"
      ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(body.x || 0)}, ${Math.round(body.y || 0)})`
      : op === "/type"
        ? `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(String(body.text || ""))})`
        : "";
  if (!script) return "";
  return (await run("powershell", ["-NoProfile", "-Command", script])).stdout;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout }) : reject(new Error(stderr || `${cmd} exited ${code}`))));
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  startWorker()
    .then(({ port, bind }) => console.log(`bops local worker on http://${bind}:${port}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
