// Local-only provider, routing, memory, worker, and the egress tripwire.
// Usage: node --experimental-strip-types scripts/test-local.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^\.{1,2}\//.test(specifier)) {
        for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
          try {
            return next(specifier + ext, context);
          } catch {}
        }
      }
      throw e;
    }
  },
});

process.env.BOPS_LOCAL_ONLY = "1";
for (const key of ["BOPS_LLM_PLANNER_MODEL", "BOPS_LLM_FAST_MODEL", "BOPS_LLM_VISION_MODEL", "BOPS_LLM_EMBED_MODEL", "BOPS_LOCAL_CONFIG"]) delete process.env[key];

const { isCloudModel, modelsFromTagsPayload, assertLocalModel, CloudModelError, localModels } = await import("../lib/local/models.ts");
const { parseConfig, useConfig, loadConfig, localOnly, callStartAllowed } = await import("../lib/local/mode.ts");
const { clearHealth, withRole, checkEndpoint } = await import("../lib/local/endpoints.ts");
const { chat, embed, looseToolCalls } = await import("../lib/local/provider.ts");
const { localScreens, screensAdvanced, localOrgoCall, localOrgoAnswered, resetLocalComputersForTests, localComputerMissing } = await import("../lib/local/orgo-adapter.ts");
const { localComputerTurn, screenResetPlan, workerAction, SCREEN_LOCKED } = await import("../lib/local/computer-session.ts");
const { solidPng, fitPng, scaleCoord } = await import("../lib/local/png-fit.ts");
const { asThirdPerson, sameFact } = await import("../lib/local/memory-store.ts");
const { scaleAction } = await import("../lib/local/computer-use.ts");
const { isSimpleLocalChat, localNeedsMemory, promisesAction, stripImitatedDeeds, taskFromPromise } = await import("../lib/local/fast-chat.ts");
const { commandNeedsApproval, botWorkspace, capOutput, shellQuote } = await import("../lib/local/shell.ts");
const { STUDIO_SCREEN_LABEL } = await import("../lib/local/mac-screen.ts");
const { transcribeLocal } = await import("../lib/local/speech.ts");
const { deleteSession, listFacts } = await import("../lib/local/memory-store.ts");
const { runResponses, resetResponsesForTests } = await import("../lib/local/responses.ts");
const { runComputerUseLoop } = await import("../lib/local/computer-use.ts");
const { addFacts, searchFacts, closeMemoryForTests, memoryDb } = await import("../lib/local/memory-store.ts");
const { installEgressGuard, LocalOnlyError, refusedConnections } = await import("../lib/local/egress.mjs");
const { startWorker, refuseBind, macKeyScript, macPointerScript, macClickScript, macTypeScript, macLockScript, bashBody, OSA_TIMEOUT_MS } = await import("../workers/bops-local-worker.mjs");
const { startProxy } = await import("../workers/bops-llm-proxy.mjs");

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n${e.stack || e.message}`);
  }
}

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}

await check("local-only defaults on, and :cloud tags are refused", async () => {
  assert.equal(localOnly(), true);
  assert.equal(isCloudModel("glm-5.3-flash:cloud"), true);
  assert.equal(isCloudModel("ornith-1.5:122b"), false);
  assert.throws(() => assertLocalModel("minimax-m2.7:cloud"), CloudModelError);
  const listed = modelsFromTagsPayload({
    models: [
      { name: "ornith-1.5:122b", size: 80 },
      { model: "qwen3:30b", details: { quantization_level: "Q4_K_M" } },
      { name: "glm-5.3-flash:cloud", remote_host: "https://ollama.com" },
    ],
  });
  assert.deepEqual(localModels(listed).map((m) => m.name), ["ornith-1.5:122b", "qwen3:30b"]);
  assert.equal(modelsFromTagsPayload({ data: [{ id: "qwen3-embedding:8b" }] })[0].name, "qwen3-embedding:8b");
  const parsed = parseConfig(
    JSON.stringify({
      llm: {
        endpoints: [{ id: "studio3", baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama" }],
        roles: { planner: { chain: [{ endpoint: "studio3", model: "glm-5.3-flash:cloud" }, { endpoint: "studio3", model: "ornith-1.5:122b" }] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] } },
      },
      workers: [],
    }),
    "mem",
  );
  assert.deepEqual(parsed.llm.roles.planner.chain.map((s) => s.model), ["ornith-1.5:122b"]);
});

await check("the example config is the model plan", async () => {
  const cfg = parseConfig(readFileSync(new URL("../bops.local.example.json", import.meta.url), "utf8"), "bops.local.example.json");
  assert.equal(cfg.llm.roles.planner.chain[0].model, "ornith-1.5:122b");
  assert.equal(cfg.llm.roles.planner.chain[1].model, "qwen3.8-flash-next:125b-mlx");
  assert.equal(cfg.llm.roles.planner.chain[2].model, "qwen3.5:122b");
  assert.equal(cfg.llm.roles.vision.chain[0].model, "qwen3.8:27b-q8_0");
  assert.equal(cfg.llm.roles.vision.chain.find((s) => s.endpoint === "geforce5").quant, "q4_K_M");
  assert.equal(cfg.llm.roles.fast.chain.at(-1).model, "qwen3:4b");
  assert.equal(cfg.llm.roles.embed.chain[0].model, "qwen3-embedding:8b");
  assert.equal(cfg.llm.roles.heavy.chain[0].model, "mlx-community/Kimi-K2.7-Code-4bit");
  const heavy = cfg.llm.roles.heavy.chain.map((s) => s.model);
  assert.ok(heavy.indexOf("zai-org/GLM-5.3-Flash") > 0 && heavy.indexOf("zai-org/GLM-5.3-Flash") < heavy.indexOf("mlx-community/GLM-5.2-mxfp4"));
  assert.equal(cfg.llm.roles.heavy.chain.at(-1).model, "qwen3.5:122b");
  assert.equal(cfg.llm.endpoints.find((e) => e.id === "exo").provider, "exo");
});

const calls = [];
const tags = { models: [{ name: "qwen3.5:122b" }, { name: "glm-5.3-flash:cloud" }] };
const good = await listen(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  calls.push({ url: req.url, body });
  if (req.url === "/api/tags") return json(res, tags);
  if (req.url === "/v1/chat/completions") {
    const tool = (body.tools ?? []).some((t) => t.function?.name === "computer");
    return json(res, {
      choices: [
        {
          message: tool
            ? { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "computer", arguments: JSON.stringify({ actions: [{ type: "click", x: 3, y: 4 }] }) } }] }
            : { content: "hello from qwen3.5" },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  }
  if (req.url === "/v1/embeddings") return json(res, { data: [{ index: 0, embedding: [1, 0] }] });
  json(res, {}, 404);
});
const missing = await listen((req, res) => {
  if (req.url === "/api/tags") return json(res, { models: [{ name: "llama3.1:8b" }] });
  json(res, { error: "model not found" }, 404);
});
const cloudTrap = await listen((req, res) => {
  calls.push({ url: "cloud-trap " + req.url });
  json(res, { models: [{ name: "glm-5.3-flash:cloud" }] });
});

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

await check("missing and down models fall through to the next local one, never :cloud", async () => {
  calls.length = 0;
  clearHealth();
  useConfig({
    llm: {
      endpoints: [
        { id: "down", baseUrl: "http://127.0.0.1:1/v1", provider: "ollama", apiKey: "" },
        { id: "missing", baseUrl: `${missing.url}/v1`, provider: "ollama", apiKey: "" },
        { id: "cloud", baseUrl: `${cloudTrap.url}/v1`, provider: "ollama", apiKey: "" },
        { id: "ok", baseUrl: `${good.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: {
          chain: [
            { endpoint: "down", model: "ornith-1.5:122b" },
            { endpoint: "missing", model: "qwen3.8-flash-next:125b-mlx" },
            { endpoint: "cloud", model: "glm-5.3-flash:cloud" },
            { endpoint: "ok", model: "qwen3.5:122b" },
          ],
        },
        fast: { chain: [{ endpoint: "ok", model: "qwen3:4b" }] },
        vision: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        embed: { chain: [{ endpoint: "ok", model: "qwen3-embedding:8b" }] },
      },
    },
    workers: [],
  });
  const result = await chat({ role: "planner", messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.content, "hello from qwen3.5");
  assert.equal(result.model, "qwen3.5:122b");
  assert.equal(result.endpoint, "ok");
  assert.ok(result.degraded.includes("does not have qwen3.8-flash-next"));
  assert.ok(result.degraded.toLowerCase().includes("cloud"));
  assert.equal(calls.some((c) => String(c.url).includes("cloud-trap")), false);
});

await check("a LAN endpoint without a token is not called", async () => {
  clearHealth();
  let fetched = 0;
  const fetchImpl = async (...args) => {
    fetched++;
    return fetch(...args);
  };
  useConfig({
    llm: {
      endpoints: [{ id: "geforce5", baseUrl: "http://192.168.1.50:11434/v1", provider: "ollama", apiKey: "" }],
      roles: { planner: { chain: [{ endpoint: "geforce5", model: "qwen3:4b" }] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] } },
    },
    workers: [],
  });
  await assert.rejects(() => withRole("planner", async () => "no", { fetchImpl }), /apiKey|authenticated|No local planner/);
  assert.equal(fetched, 0);
});

await check("responses computer actions and offline web search", async () => {
  clearHealth();
  useConfig({
    llm: {
      endpoints: [{ id: "ok", baseUrl: `${good.url}/v1`, provider: "ollama", apiKey: "" }],
      roles: {
        planner: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        fast: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        vision: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        embed: { chain: [{ endpoint: "ok", model: "qwen3-embedding:8b" }] },
      },
    },
    workers: [],
  });
  resetResponsesForTests();
  const turned = await runResponses({ model: "gpt-6-astra", tools: [{ type: "computer" }], input: "open the sheet" });
  assert.equal(turned.output[0].type, "computer_call");
  assert.equal(turned.output[0].actions[0].type, "click");
  const searchServer = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.5:122b" }] });
    const asked = JSON.stringify(body.messages);
    const content = asked.includes("unavailable") ? "I can't look that up offline." : "";
    const tool_calls = content ? undefined : [{ id: "call_s", type: "function", function: { name: "web_search", arguments: "{\"query\":\"news\"}" } }];
    json(res, { choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) } }] });
  });
  clearHealth();
  useConfig({
    llm: {
      endpoints: [{ id: "ok", baseUrl: `${searchServer.url}/v1`, provider: "ollama" }],
      roles: {
        planner: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        fast: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        vision: { chain: [{ endpoint: "ok", model: "qwen3.5:122b" }] },
        embed: { chain: [] },
      },
    },
    workers: [],
  });
  const searched = await runResponses({ tools: [{ type: "web_search" }], input: "what's new" });
  assert.match(searched.output_text, /offline/);
  searchServer.server.close();
});

await check("loose tool JSON and embeddings across Ollama versions", async () => {
  assert.equal(looseToolCalls('sure {"tool":"remember","arguments":{"fact":"Ada"}}').at(0).name, "remember");
  const old = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3-embedding:8b" }] });
    if (req.url === "/v1/embeddings") return json(res, { error: "no" }, 404);
    if (req.url === "/api/embed") return json(res, { error: "no" }, 404);
    if (req.url === "/api/embeddings") return json(res, { embedding: [0, 1] });
    json(res, {}, 404);
  });
  clearHealth();
  useConfig({
    llm: {
      endpoints: [{ id: "old", baseUrl: `${old.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [{ endpoint: "old", model: "qwen3-embedding:8b" }] } },
    },
    workers: [],
  });
  const vectors = await embed(["Ada"]);
  assert.deepEqual(vectors, [[0, 1]]);
  old.server.close();
});

await check("sqlite memory still finds a fact when embeddings are down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bops-mem-"));
  process.env.BOPS_MEMORY_PATH = join(dir, "memory.sqlite");
  closeMemoryForTests();
  clearHealth();
  useConfig({
    llm: { endpoints: [], roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [{ endpoint: "missing", model: "qwen3-embedding:8b" }] } } },
    workers: [],
  });
  await addFacts("bops", [{ content: "Ada's sister Ana lives in Lisbon." }]);
  const found = await searchFacts("bops", "where does Ana live", 3);
  assert.match(found[0].content, /Lisbon/);
  rmSync(dir, { recursive: true, force: true });
  closeMemoryForTests();
});

await check("computer-use loop and the local worker", async () => {
  assert.match(refuseBind("0.0.0.0"), /every interface/);
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const res = await fetch(`http://127.0.0.1:${worker.port}/health`);
  assert.equal((await res.json()).ok, true);
  clearHealth();
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const seen = JSON.stringify(body.messages).includes("So far");
    json(res, {
      choices: [
        {
          message: seen
            ? { content: "Done.", tool_calls: [{ id: "c2", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [] }) } }] }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "computer", arguments: JSON.stringify({ actions: [{ type: "click", x: 8, y: 9 }] }) } }] },
        },
      ],
    });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] } },
    },
    workers: [],
  });
  const actions = [];
  const loop = await runComputerUseLoop({
    goal: "press the button",
    screenshot: async () => ({ mime: "image/png", base64: "aGk=" }),
    act: async (list) => {
      actions.push(...list);
      return "clicked";
    },
  });
  assert.equal(actions[0].type, "click");
  assert.match(loop.text, /click/);
  vision.server.close();
  worker.server.close();
});

await check("the llm proxy requires a token and stays on loopback upstream", async () => {
  const upstream = await listen((req, res) => json(res, { models: [{ name: "qwen3:4b" }] }));
  const proxy = await startProxy({ bind: "127.0.0.1", port: 0, token: "secret", upstream: upstream.url });
  const denied = await fetch(`http://127.0.0.1:${proxy.port}/api/tags`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`http://127.0.0.1:${proxy.port}/api/tags`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(allowed.status, 200);
  assert.throws(() => startProxy({ bind: "0.0.0.0", token: "secret", upstream: upstream.url }), /every interface/);
  proxy.server.close();
  upstream.server.close();
});

await check("a follow-up image is the message the vision model answers", async () => {
  clearHealth();
  resetResponsesForTests();
  let sent;
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    sent = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    json(res, { choices: [{ message: { content: "a red square" } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [],
  });
  const out = await runResponses({
    input: [
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: [{ type: "input_text", text: "What is in this picture?" }, { type: "input_image", image_url: "data:image/png;base64,NEWIMAGE" }] },
      { role: "developer", content: "As of now: Monday" },
    ],
  });
  const last = JSON.stringify(sent.messages.at(-1));
  assert.match(last, /NEWIMAGE/);
  assert.match(last, /What is in this picture/);
  assert.equal(last.includes("capital of France"), false);
  assert.equal(last.includes("As of now"), false);
  assert.equal(out.model, "qwen3.8:27b-q8_0");
  vision.server.close();
});

await check("a later text question does not stay on the vision model or the earlier image", async () => {
  clearHealth();
  resetResponsesForTests();
  let sent;
  const models = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }, { name: "qwen3.8:27b-q8_0" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    sent = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    json(res, { choices: [{ message: { content: sent.model === "ornith-1.5:122b" ? "green, yellow, or bare copper" : "from the picture" } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "studio3", baseUrl: `${models.url}/v1`, provider: "ollama" }],
      roles: {
        planner: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] },
        fast: { chain: [] },
        vision: { chain: [{ endpoint: "studio3", model: "qwen3.8:27b-q8_0" }] },
        embed: { chain: [] },
        heavy: { chain: [] },
      },
    },
    workers: [],
  });
  const input = [
    { role: "user", content: [{ type: "input_text", text: "what color is this" }, { type: "input_image", image_url: "data:image/png;base64,OLDIMAGE" }] },
    { role: "assistant", content: "blue" },
    { role: "user", content: "what color is a ground wire" },
  ];
  const { roleFor, latestUserHasImage } = await import("../lib/local/responses.ts");
  assert.equal(latestUserHasImage(input), false);
  assert.equal(roleFor({ input }), "planner");
  const out = await runResponses({ input });
  assert.equal(out.model, "ornith-1.5:122b");
  assert.equal(JSON.stringify(sent.messages).includes("OLDIMAGE"), false);
  assert.match(JSON.stringify(sent.messages.at(-1)), /ground wire/);
  models.server.close();
});

await check("mac keys, clicks, and typing post core graphics events", async () => {
  assert.match(macKeyScript("Return"), /CGEventCreateKeyboardEvent\(src, 36, true\)/);
  assert.doesNotMatch(macKeyScript("Return"), /System Events|keystroke/);
  assert.match(macKeyScript("Tab"), /CGEventCreateKeyboardEvent\(src, 48, true\)/);
  assert.match(macKeyScript("Escape"), /CGEventCreateKeyboardEvent\(src, 53, true\)/);
  assert.match(macKeyScript("Delete"), /CGEventCreateKeyboardEvent\(src, 51, true\)/);
  assert.match(macKeyScript("Left"), /CGEventCreateKeyboardEvent\(src, 123, true\)/);
  assert.match(macKeyScript("Down"), /CGEventCreateKeyboardEvent\(src, 125, true\)/);
  assert.match(macKeyScript("cmd+c"), /CGEventCreateKeyboardEvent\(src, 8, true\)/);
  assert.match(macKeyScript("cmd+c"), /1048576/);
  assert.match(macKeyScript("ctrl+shift+Tab"), /CGEventCreateKeyboardEvent\(src, 48, true\)/);
  assert.match(macKeyScript("alt+Left"), /CGEventCreateKeyboardEvent\(src, 123, true\)/);
  assert.match(macKeyScript("shift+Return"), /CGEventCreateKeyboardEvent\(src, 36, true\)/);
  assert.match(macKeyScript("cmd+ctrl+alt+shift+Escape"), /CGEventCreateKeyboardEvent\(src, 53, true\)/);
  assert.match(macKeyScript("a"), /CGEventCreateKeyboardEvent\(src, 0, true\)/);
  assert.match(macKeyScript("/"), /CGEventKeyboardSetUnicodeString/);
  assert.doesNotMatch(macTypeScript("hi"), /System Events/);
  assert.match(macClickScript({ x: 10, y: 20 }), /CGEventCreateMouseEvent/);
  assert.doesNotMatch(macClickScript({ x: 1, y: 2, double: true }), /System Events/);
  assert.throws(() => macKeyScript("ReturnKey"), /Unknown key/);
  const move = macPointerScript("/move", { x: 12, y: 34 });
  assert.match(move, /CGEventCreateMouseEvent/);
  assert.match(move, /CGPointMake\(12, 34\)/);
  assert.doesNotMatch(move, /CGEventCreateScrollWheelEvent/);
  assert.match(macLockScript(), /ObjC\.castRefToObject\(\$\.CGSessionCopyCurrentDictionary\(\)\)/);
  assert.match(macLockScript(), /v && v\.js \? "locked" : "open"/);
  const scroll = macPointerScript("/scroll", { x: 3, y: 4, scroll_y: 120, scroll_x: -40 });
  assert.match(scroll, /CGEventCreateMouseEvent/);
  assert.match(scroll, /CGEventCreateScrollWheelEvent\(src, 0, 2, -120, -40\)/);
});

await check("the mac lock script prints locked or open", async () => {
  if (process.platform !== "darwin") return;
  const said = await new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", macLockScript()], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("osascript timed out"));
    }, 4000);
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim() || `osascript exited ${code}`));
      else resolve(out.trim());
    });
  });
  assert.match(said, /^(locked|open)$/);
});

await check("structured calls send a schema and fences are stripped", async () => {
  clearHealth();
  resetResponsesForTests();
  const schemas = [];
  const model = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    schemas.push(body.format);
    json(res, { message: { content: '```json\n{"name":"Wire a lamp"}\n```' } });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "studio3", baseUrl: `${model.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [],
  });
  const skill = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const out = await runResponses({ input: "save this chat as a skill", text: { format: { type: "json_schema", name: "skill_draft", schema: skill, strict: true } } });
  assert.deepEqual(schemas[0], skill);
  assert.equal(out.output_text, '{"name":"Wire a lamp"}');
  schemas.length = 0;
  await runResponses({ input: "route", text: { format: { type: "json_object" } } });
  assert.deepEqual(schemas[0], { type: "object" });
  model.server.close();
});

await check("planner chats ask Ollama to keep the model loaded", async () => {
  clearHealth();
  let keep;
  const model = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    keep = JSON.parse(Buffer.concat(chunks).toString() || "{}").keep_alive;
    json(res, { choices: [{ message: { content: "ok" } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "studio3", baseUrl: `${model.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [],
  });
  await chat({ role: "planner", messages: [{ role: "user", content: "hi" }] });
  assert.equal(keep, "24h");
  model.server.close();
});

await check("local screens name their displays, and a stuck screen list stops", async () => {
  const screens = localScreens();
  assert.ok(screens.some((s) => s.display === ":100" && s.vnc_port && s.ws_port));
  assert.equal(screens.length >= 4, true);
  assert.equal(screensAdvanced([{ display: ":100" }], [{ display: ":100" }], 101), "stuck");
  assert.equal(screensAdvanced([], [{ display: ":100" }], 100), "ready");
  assert.equal(screensAdvanced([{ display: ":100" }], [{ display: ":100" }, { display: ":101" }], 102), "grew");
});

await check("a local computer task talks to the worker, not an agents API", async () => {
  clearHealth();
  const seen = [];
  let asked = 0;
  let sawSession = false;
  let sawClick = false;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    seen.push(req.url);
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    asked += 1;
    const live = [...worker.sessions.values()];
    if (live.length) sawSession = true;
    if (live.some((s) => s.actions.some((a) => a.op === "click" && a.body?.x === 12))) sawClick = true;
    if (asked === 1) {
      return json(res, { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "computer", arguments: JSON.stringify({ actions: [{ type: "click", x: 12, y: 34 }] }) } }] } }] });
    }
    json(res, { choices: [{ message: { content: "Done.", tool_calls: [{ id: "c2", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [] }) } }] } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const text = await localComputerTurn("task-1", "take a screenshot");
  assert.match(text, /click/);
  assert.equal(sawSession, true);
  assert.equal(sawClick, true);
  assert.equal(seen.some((u) => String(u).includes("agents")), false);
  vision.server.close();
  worker.server.close();
});

await check("a local computer task records each step and never shells out to xdotool", async () => {
  clearHealth();
  const steps = [];
  let bash = false;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    json(res, {
      choices: [
        {
          message: {
            content: "Finder is the frontmost app.",
            tool_calls: [{ id: "c1", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [{ type: "move", x: 640, y: 480 }] }) } }],
          },
        },
      ],
    });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const text = await localComputerTurn("task-steps", "screenshot and move to the center", fetch, (action) => {
    steps.push(action);
    for (const session of worker.sessions.values()) {
      if (session.actions.some((a) => a.op === "bash" && /xdotool|DISPLAY=|\/usr\/local\/bin|\/root|\/opt\/bops/.test(JSON.stringify(a.body)))) bash = true;
    }
  });
  assert.match(text, /Finder is the frontmost app/);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "move");
  assert.equal(workerAction(steps[0]).path, "/move");
  assert.equal(bash, false);
  assert.equal(screenResetPlan().shell, null);
  vision.server.close();
  worker.server.close();
});

await check("mouse_move reaches the worker as /move", async () => {
  clearHealth();
  let moved = false;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    json(res, {
      choices: [
        {
          message: {
            content: "The pointer is at the center.",
            tool_calls: [{ id: "c1", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [{ type: "mouse_move", x: 640, y: 480 }] }) } }],
          },
        },
      ],
    });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const text = await localComputerTurn("task-alias", "what app is frontmost", fetch, () => {
    for (const session of worker.sessions.values()) if (session.actions.some((a) => a.op === "move" && a.body?.x === 640)) moved = true;
  });
  assert.equal(moved, true);
  assert.match(text, /pointer is at the center/);
  assert.equal(/^done\.?$/i.test(text), false);
  vision.server.close();
  worker.server.close();
});

await check("a repeated computer action stops the loop", async () => {
  clearHealth();
  let asked = 0;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!body.tools) return json(res, { choices: [{ message: { content: "Safari is the frontmost app." } }] });
    asked += 1;
    json(res, { choices: [{ message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "computer", arguments: JSON.stringify({ actions: [{ type: "move", x: 1, y: 1 }] }) } }] } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const text = await localComputerTurn("task-repeat", "what app is frontmost");
  assert.match(text, /Safari is the frontmost app/);
  assert.equal(asked, 2);
  vision.server.close();
  worker.server.close();
});

await check("screenshot coordinates scale from the image back to the screen", async () => {
  clearHealth();
  const png = solidPng(1280, 720);
  const fit = fitPng(png, 1024);
  assert.equal(fit.screenW, 1280);
  assert.equal(fit.sentW, 1024);
  assert.equal(fit.sentH, 576);
  assert.equal(scaleCoord(512, 1280, 1024), 640);
  assert.equal(scaleCoord(288, 1280, 1024), 360);
  const seen = [];
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    seen.push(JSON.stringify(body.messages ?? body));
    json(res, { choices: [{ message: { content: "The desktop is showing.", tool_calls: [{ id: "c", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [{ type: "move", x: 512, y: 288 }] }) } }] } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const made = await fetch(`http://127.0.0.1:${worker.port}/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const session = await made.json();
  const { runComputerUseLoop } = await import("../lib/local/computer-use.ts");
  await runComputerUseLoop({
    goal: "move to the center",
    screenshot: async () => ({ mime: "image/png", base64: png.toString("base64") }),
    act: async (actions) => {
      await fetch(`http://127.0.0.1:${worker.port}/v1/sessions/${session.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: actions[0].x, y: actions[0].y }) });
      return "moved";
    },
  });
  const got = worker.sessions.get(session.id).actions.find((a) => a.op === "move");
  assert.equal(got.body.x, 640);
  assert.equal(got.body.y, 360);
  assert.match(seen.join("\n"), /1024/);
  assert.equal(scaleAction({ type: "move", x: 512, y: 288 }, 1280, 1024).x, 640);
  vision.server.close();
  worker.server.close();
});

await check("a locked screen stops a computer task", async () => {
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "", locked: true });
  useConfig({
    llm: { endpoints: [], roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [] } } },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const text = await localComputerTurn("task-locked", "look at the screen");
  assert.equal(text, SCREEN_LOCKED);
  worker.server.close();
});

await check("a local screen reset does not write /usr/local/bin", async () => {
  assert.equal(screenResetPlan(true).shell, null);
  assert.equal(screenResetPlan(false).shell, "/usr/local/bin/bops-reset-screen");
  const stripped = stripImitatedDeeds('On it.\n[What was done: started the task "Screenshot and center mouse"]');
  assert.equal(stripped.claimedTask, "Screenshot and center mouse");
  assert.equal(stripped.text.includes("[What was done:"), false);
  assert.equal(localNeedsMemory("Start a task to take a screenshot"), false);
  assert.equal(localNeedsMemory("remember that I prefer tea"), true);
  assert.equal(isSimpleLocalChat("Please remember for later: my shop truck is blue"), false);
  assert.equal(asThirdPerson("my shop truck is blue", "Sam"), "Sam's shop truck is blue");
  assert.equal(sameFact("my shop truck is blue", "Sam's shop truck is blue", "Sam"), true);
  const history = '[What was done: started the task "Screenshot and center mouse"]';
  const user = "Start another task: move the pointer to (300, 200) and take a screenshot. (use start_task)";
  const reply = "Moving the pointer to (300, 200) and taking a screenshot now.";
  const plan = taskFromPromise(user, reply, false, history);
  assert.ok(plan);
  assert.match(plan.goal, /300, 200/);
  assert.equal(taskFromPromise(user, reply, true, history), null);
  assert.equal(OSA_TIMEOUT_MS <= 8000, true);
});

await check("bash on the worker returns exit_code instead of failing the request", async () => {
  assert.equal(bashBody(1, "", "no such file").exit_code, 1);
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "native", token: "" });
  const made = await fetch(`http://127.0.0.1:${worker.port}/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const { id } = await made.json();
  const res = await fetch(`http://127.0.0.1:${worker.port}/v1/sessions/${id}/bash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo hello; exit 1" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exit_code, 1);
  assert.match(body.output, /hello/);
  worker.server.close();
});

async function restartWorker(worker) {
  const port = worker.port;
  await new Promise((resolve) => worker.server.close(resolve));
  return startWorker({ bind: "127.0.0.1", port, kind: "fake", token: "" });
}

await check("a saved local computer still screenshots and runs bash after a restart", async () => {
  resetLocalComputersForTests();
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  useConfig({
    llm: { endpoints: [], roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [] } } },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const made = await localOrgoCall("POST", "/computers", { name: "Boppy" });
  assert.match(made.id, /^local_studio3_[A-Za-z0-9-]{8,}$/);
  resetLocalComputersForTests();
  const again = await restartWorker(worker);
  const shot = await localOrgoAnswered(`http://local.invalid/computers/${encodeURIComponent(made.id)}/screenshot`, {}, 5000, undefined, async (res) => Buffer.from(await res.arrayBuffer()));
  assert.equal(shot.res.status, 200);
  assert.ok(shot.text.length > 8);
  const bash = await localOrgoCall("POST", `/computers/${encodeURIComponent(made.id)}/bash`, { command: "echo hi" });
  assert.equal(bash.exit_code, 0);
  assert.match(bash.output, /ok/);
  await assert.rejects(localOrgoCall("GET", "/computers/local_missing_0123456789abcdef"), (e) => localComputerMissing(e));
  again.server.close();
  resetLocalComputersForTests();
});

await check("a computer task finishes on the saved computer after a restart", async () => {
  clearHealth();
  resetLocalComputersForTests();
  let asked = 0;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
    asked += 1;
    if (asked === 1) {
      return json(res, { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "computer", arguments: JSON.stringify({ actions: [{ type: "click", x: 20, y: 30 }] }) } }] } }] });
    }
    json(res, { choices: [{ message: { content: "Done.", tool_calls: [{ id: "c2", type: "function", function: { name: "computer", arguments: JSON.stringify({ done: true, actions: [] }) } }] } }] });
  });
  useConfig({
    llm: {
      endpoints: [{ id: "v", baseUrl: `${vision.url}/v1`, provider: "ollama" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [{ endpoint: "v", model: "qwen3.8:27b-q8_0" }] }, embed: { chain: [] }, heavy: { chain: [] } },
    },
    workers: [{ id: "studio3", url: `http://127.0.0.1:${worker.port}`, token: "" }],
  });
  const made = await localOrgoCall("POST", "/computers", { name: "Boppy" });
  resetLocalComputersForTests();
  const again = await restartWorker(worker);
  const result = await runComputerUseLoop({
    goal: "click the button",
    screenshot: async () => {
      const shot = await localOrgoAnswered(`http://local.invalid/computers/${encodeURIComponent(made.id)}/screenshot`, {}, 5000, undefined, async (res) => Buffer.from(await res.arrayBuffer()));
      if (!shot.res.ok) return null;
      return { mime: "image/png", base64: shot.text.toString("base64") };
    },
    act: async (actions) => {
      for (const action of actions) {
        if (action.type === "click") await localOrgoCall("POST", `/computers/${encodeURIComponent(made.id)}/click`, { x: action.x, y: action.y });
      }
      return actions.map((a) => a.type).join(", ");
    },
  });
  assert.match(result.text, /click/);
  const remote = made.id.slice("local_studio3_".length);
  const session = again.sessions.get(remote);
  assert.ok(session?.actions.some((a) => a.op === "click" && a.body?.x === 20));
  vision.server.close();
  again.server.close();
  resetLocalComputersForTests();
});

await check("a local call may start without an SDP offer", async () => {
  assert.equal(callStartAllowed("", true), true);
  assert.equal(callStartAllowed(undefined, true), true);
  assert.equal(callStartAllowed("", false), false);
  assert.equal(callStartAllowed("v=0", false), true);
});

await check("a short local chat skips the router and memory models", async () => {
  assert.equal(isSimpleLocalChat("hi"), true);
  assert.equal(isSimpleLocalChat("pong"), true);
  assert.equal(isSimpleLocalChat("search the web for the weather"), false);
  assert.equal(isSimpleLocalChat("hi", { images: true }), false);
  assert.equal(isSimpleLocalChat("x".repeat(241)), false);
});

await check("local speech uses the configured server and never a cloud host", async () => {
  const heard = [];
  const speech = await listen(async (req, res) => {
    heard.push(req.url);
    json(res, { text: "turn on the lamp" });
  });
  process.env.BOPS_LLM_TRANSCRIBE_URL = speech.url;
  delete process.env.BOPS_WHISPER_BIN;
  const text = await transcribeLocal(Buffer.from("audio"));
  assert.equal(text, "turn on the lamp");
  delete process.env.BOPS_LLM_TRANSCRIBE_URL;
  await assert.rejects(transcribeLocal(Buffer.from("audio")), /not sent to a cloud/);
  speech.server.close();
});

await check("deleting a bot session removes its local memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bops-mem-"));
  process.env.BOPS_MEMORY_PATH = join(dir, "memory.sqlite");
  closeMemoryForTests();
  await addFacts("bops", [{ content: "The code is TEAL-42.", sessionId: "bops-chat-bot-z" }]);
  deleteSession("bops", "bops-chat-bot-z");
  assert.equal(listFacts("bops").some((f) => f.sessionId === "bops-chat-bot-z"), false);
  rmSync(dir, { recursive: true, force: true });
  closeMemoryForTests();
});

await check("local settings do not open an external account or billing page", async () => {
  const { isExternalAccountUrl, externalAccountUrlsIn, localAccountPayload } = await import("../lib/local/settings-links.ts");
  const { readLocalProfile, writeLocalProfile } = await import("../lib/local/profile.ts");
  const blocked = [
    "https://www.orgo.ai/account?tab=plan",
    "https://www.orgo.ai/account?tab=usage",
    "https://www.orgo.ai/settings/billing",
    "https://www.orgo.ai/settings/billing#credits",
    "https://www.orgo.ai/settings/api-keys",
    "https://www.orgo.ai/workspaces",
    "https://www.orgo.ai/workspaces?project_id=p",
    "https://www.orgo.ai/privacy",
    "https://www.orgo.ai/terms",
    "https://orgo.cal.com/nick/20-min-meeting",
    "https://checkout.stripe.com/c/pay_x",
    "https://billing.stripe.com/p/session",
    "https://accounts.google.com/o/oauth2/v2/auth",
  ];
  for (const url of blocked) assert.equal(isExternalAccountUrl(url), true, url);
  assert.equal(isExternalAccountUrl("sms:+15551212"), false);
  assert.equal(isExternalAccountUrl("mailto:ada@example.com"), false);
  assert.equal(isExternalAccountUrl("http://127.0.0.1:11434/v1"), false);
  assert.deepEqual(externalAccountUrlsIn(localAccountPayload("Ada")), []);

  for (const file of ["app/api/account/route.ts", "app/api/account/checkout/route.ts", "app/api/account/manage/route.ts", "app/api/account/credit/route.ts", "app/api/plan/route.ts", "app/api/runs-on/keys/route.ts"]) {
    const text = readFileSync(file, "utf8");
    const guard = text.indexOf("if (localOnly())");
    assert.ok(guard > 0, `${file} does not stop in local mode`);
    const built = text.search(/orgoPages\(|orgoKeysPage\(/);
    if (built >= 0) assert.ok(guard < built, `${file} builds an Orgo page before the local check`);
  }
  assert.match(readFileSync("lib/server/members.ts", "utf8"), /if \(localOnly\(\)\) return ok\(\{ state: "self_hosted" \}\)/);

  const settings = readFileSync("components/app/bops-app.tsx", "utf8");
  const settingsFn = settings.slice(settings.indexOf("export function Settings"), settings.indexOf("function FirstLoad"));
  assert.match(settingsFn, /scrollTop = 0/);
  assert.match(settingsFn, /overflowAnchor: "none"/);
  assert.match(settingsFn, /Local: no plan or billing/);
  assert.match(settingsFn, /<LocalMachines \/>/);
  assert.doesNotMatch(settingsFn, /window\.open\(/);

  const guarded = [
    ["components/app/account.tsx", "if (local) return null"],
    ["components/app/plan-note.tsx", "if (local || !info.links?.plan)"],
    ["components/app/members.tsx", "!local && read.orgoUrl"],
    ["components/app/bot-computers.tsx", "!local &&"],
    ["components/app/computer-size.tsx", "if (local) return null"],
    ["components/app/computer.tsx", "if (local) return null"],
    ["components/app/owner-phone.tsx", "!local &&"],
    ["components/app/bot-panel.tsx", "!local &&"],
    ["components/app/sign-in.tsx", "There is no Orgo, Google, or email sign-in"],
    ["components/app/app-settings.tsx", "error.topUp && !local"],
    ["components/app/sidebar.tsx", "user && !local"],
    ["components/app/notice-popup.tsx", "isExternalAccountUrl"],
  ];
  for (const [file, needle] of guarded) assert.match(readFileSync(file, "utf8"), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), file);

  const dir = mkdtempSync(join(tmpdir(), "bops-profile-"));
  const cfg = join(dir, "bops.local.json");
  writeFileSync(cfg, `${JSON.stringify({ llm: { endpoints: [], roles: {} }, workers: [], token: "stay" })}\n`);
  const prev = process.env.BOPS_LOCAL_CONFIG;
  process.env.BOPS_LOCAL_CONFIG = cfg;
  try {
    writeLocalProfile({ name: "Ada", about: "Runs the shop" });
    assert.deepEqual(readLocalProfile(), { name: "Ada", about: "Runs the shop" });
    const saved = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(saved.profile.name, "Ada");
    assert.equal(saved.token, "stay");
    assert.deepEqual(externalAccountUrlsIn(saved), []);
  } finally {
    if (prev === undefined) delete process.env.BOPS_LOCAL_CONFIG;
    else process.env.BOPS_LOCAL_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("commands and fact questions are not a no-tools chat", async () => {
  assert.equal(isSimpleLocalChat("hi"), true);
  assert.equal(isSimpleLocalChat("pong"), true);
  assert.equal(isSimpleLocalChat("I usually type `hermes update` in the terminal"), false);
  assert.equal(isSimpleLocalChat("how many people are in montana state?"), false);
  assert.equal(isSimpleLocalChat("what's the weather in missoula"), false);
  assert.equal(isSimpleLocalChat("brew upgrade ffmpeg"), false);
  assert.equal(promisesAction("I can run that for you. Let me try it."), true);
  assert.equal(promisesAction("I'm here."), false);
  assert.equal(commandNeedsApproval("ollama list"), null);
  assert.equal(commandNeedsApproval("hermes update"), null);
  assert.equal(commandNeedsApproval("brew upgrade ffmpeg"), null);
  assert.equal(commandNeedsApproval("rm -rf ~/notes"), "deletes files recursively");
  assert.equal(commandNeedsApproval("sudo reboot"), "uses sudo");
  assert.equal(commandNeedsApproval("git push --force origin main"), "force-pushes");
  assert.equal(commandNeedsApproval("echo hi > /etc/hosts"), "writes outside your home folder");
  assert.equal(commandNeedsApproval("pkill -f bops"), "would stop Bops");
  assert.match(botWorkspace("nova"), /bops\/\.data\/workspaces\/nova$/);
  assert.match(shellQuote("/tmp/a b"), /'/);
  assert.match(capOutput("x".repeat(20), 8), /truncated/);
  assert.equal(STUDIO_SCREEN_LABEL, "Studio 3 screen");
  const screens = (await import("../lib/local/orgo-adapter.ts")).localScreens();
  assert.ok(screens.every((s) => s.label.includes("Studio 3 screen")));
  assert.match(readFileSync("lib/server/browser-view.ts", "utf8"), /if \(localOnly\(\)\) return localStudioScreen/);
  assert.match(readFileSync("app/api/screen/route.ts", "utf8"), /workerScreenPng/);
  assert.match(readFileSync("lib/server/chat.ts", "utf8"), /run_command/);
  const tabs = readFileSync("components/app/panel-tabs.tsx", "utf8");
  assert.match(tabs, /local && !egress/);
  assert.match(tabs, /Search the web for/);
});

await check("shared brain merges search and user-only facts stay", async () => {
  const { factsToKeep, statesUserFact } = await import("../lib/local/memory-facts.ts");
  const { searchSharedBrain, saveSharedBrain } = await import("../lib/local/shared-brain.ts");
  const { isLocalAddress } = await import("../lib/local/egress.mjs");
  const assistant = "I'll update the Hermes app for you and restart it after the download.";
  assert.equal(statesUserFact(assistant), false);
  assert.deepEqual(
    factsToKeep(assistant, ["The user is updating the Hermes app.", "The user will restart Hermes after the download.", "The user downloaded a Hermes update."], "Alvis"),
    [],
  );
  assert.deepEqual(factsToKeep("I prefer tea in the morning", ["Alvis prefers tea in the morning.", "Alvis prefers tea in the morning.", "Alvis is updating the Hermes app."], "Alvis"), ["Alvis prefers tea in the morning."]);
  assert.equal(isLocalAddress("100.65.194.95"), true);
  assert.equal(isLocalAddress("100.63.1.1"), false);
  assert.equal(isLocalAddress("100.128.0.1"), false);
  const seen = [];
  const brain = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url === "/api/search") return json(res, { results: [{ memory: { content: "The shop truck is blue." }, similarity_score: 0.9 }] });
    if (req.url === "/api/memories") return json(res, { ok: true });
    return json(res, { error: "no" }, 404);
  });
  process.env.BOPS_SHARED_BRAIN_URL = brain.url;
  process.env.BOPS_SHARED_BRAIN_KEY = "tailnet-key";
  process.env.BOPS_SHARED_BRAIN_MACHINE = "studio3";
  try {
    const hits = await searchSharedBrain("truck");
    assert.deepEqual(hits, [{ content: "The shop truck is blue." }]);
    assert.equal(await saveSharedBrain("Hermes update finished.", "nova"), true);
    assert.deepEqual(await searchSharedBrain(""), []);
    const down = await searchSharedBrain("truck", 3, async () => { throw new Error("down"); });
    assert.deepEqual(down, []);
  } finally {
    delete process.env.BOPS_SHARED_BRAIN_URL;
    delete process.env.BOPS_SHARED_BRAIN_KEY;
    delete process.env.BOPS_SHARED_BRAIN_MACHINE;
    brain.server.close();
  }
  assert.equal(seen[0].auth, "Bearer tailnet-key");
  assert.equal(seen[1].body.tags.join(","), "bops,bot:nova,machine:studio3");
  assert.match(readFileSync("lib/server/memory.ts", "utf8"), /statesUserFact/);
  assert.match(readFileSync("lib/server/chat.ts", "utf8"), /save_shared_memory/);
});

await check("lan probes, machine name, chat tasks, and a role", async () => {
  const { orderLocalAddresses } = await import("../lib/local/egress.mjs");
  const { describeFetchError, checkEndpoint, clearHealth } = await import("../lib/local/endpoints.ts");
  const { machineLabel } = await import("../lib/local/machine.ts");
  const { needsScreen, commandOf } = await import("../lib/local/delegate.ts");
  const ordered = orderLocalAddresses([
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "fd7a:115c:a1e0::1", family: 6 },
    { address: "192.168.1.20", family: 4 },
  ]);
  assert.equal(ordered[0].address, "192.168.1.20");
  assert.equal(ordered.some((a) => a.address.startsWith("2606:")), false);
  const err = new TypeError("fetch failed");
  err.cause = { code: "ECONNREFUSED" };
  assert.equal(describeFetchError(err), "fetch failed (ECONNREFUSED)");
  clearHealth();
  const health = await checkEndpoint({ id: "studio1", baseUrl: "http://studio1.local:11435/v1", provider: "ollama", apiKey: "k" }, async () => {
    throw err;
  });
  assert.equal(health.ok, false);
  assert.match(health.error, /ECONNREFUSED/);
  assert.equal(machineLabel("studio3"), "Studio 3");
  assert.equal(machineLabel("Studio 3"), "Studio 3");
  assert.equal(needsScreen("click the login form in the browser"), true);
  assert.equal(needsScreen("ask nova to run hermes update"), false);
  assert.equal(commandOf("please run `hermes update`"), "hermes update");
  assert.match(readFileSync("lib/bot-settings.ts", "utf8"), /export function cleanRole/);
  assert.match(readFileSync("app/api/memory/route.ts", "utf8"), /Memory took too long/);
  assert.match(readFileSync("app/api/bots/route.ts", "utf8"), /setBotRole/);
  assert.match(readFileSync("components/app/bot-settings.tsx", "utf8"), /data-role-editor/);
});

await check("weather is answered live and search urls can be fetched", async () => {
  const { weatherPlace, webSearch } = await import("../lib/local/web-search.ts");
  const { urlsInSearch, webSearchCall } = await import("../lib/local/responses.ts");
  assert.equal(weatherPlace("what's the weather in Missoula"), "Missoula");
  assert.equal(weatherPlace("how many people live in Missoula"), null);
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith("https://wttr.in/")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ current_condition: [{ temp_F: "37", temp_C: "3", humidity: "75", windspeedMiles: "5", weatherDesc: [{ value: "Cloudy" }] }], nearest_area: [{ areaName: [{ value: "Missoula" }], region: [{ value: "Montana" }], country: [{ value: "United States" }] }] }) };
    }
    return { ok: false, status: 503, text: async () => "" };
  };
  const text = await webSearch("what's the weather in Missoula", fetchImpl);
  assert.match(text, /37°F/);
  assert.match(text, /Missoula, Montana/);
  assert.match(text, /https:\/\/wttr\.in\//);
  const call = webSearchCall(urlsInSearch(text));
  assert.equal(call.type, "web_search_call");
  assert.ok(call.action.sources.some((s) => s.url.includes("wttr.in")));
});

await check("egress tripwire refuses public hosts and still allows loopback", async () => {
  installEgressGuard();
  await assert.rejects(fetch("https://api.openai.com/v1/models"), LocalOnlyError);
  await assert.rejects(fetch("https://ollama.com/api/tags"), LocalOnlyError);
  await new Promise((resolve, reject) => {
    const socket = net.connect(443, "1.1.1.1");
    socket.on("error", (e) => (e instanceof LocalOnlyError ? resolve() : reject(e)));
    socket.on("connect", () => reject(new Error("a public address connected")));
  });
  const local = await listen((req, res) => json(res, { ok: true }));
  const res = await fetch(`${local.url}/health`);
  assert.equal((await res.json()).ok, true);
  local.server.close();
  assert.ok(refusedConnections().includes("api.openai.com"));
  const health = await checkEndpoint({ id: "ok", baseUrl: `${good.url}/v1`, provider: "ollama", apiKey: "" });
  assert.equal(health.ok, true);
});

good.server.close();
missing.server.close();
cloudTrap.server.close();

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall local tests passed");
