// Local-only provider, routing, memory, worker, and the egress tripwire.
// Usage: node --experimental-strip-types scripts/test-local.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { localComputerTurn, screenResetPlan, workerAction } = await import("../lib/local/computer-session.ts");
const { isSimpleLocalChat, localNeedsMemory, stripImitatedDeeds } = await import("../lib/local/fast-chat.ts");
const { transcribeLocal } = await import("../lib/local/speech.ts");
const { deleteSession, listFacts } = await import("../lib/local/memory-store.ts");
const { runResponses, resetResponsesForTests } = await import("../lib/local/responses.ts");
const { runComputerUseLoop } = await import("../lib/local/computer-use.ts");
const { addFacts, searchFacts, closeMemoryForTests, memoryDb } = await import("../lib/local/memory-store.ts");
const { installEgressGuard, LocalOnlyError, refusedConnections } = await import("../lib/local/egress.mjs");
const { startWorker, refuseBind, macKeyScript, macPointerScript, bashBody } = await import("../workers/bops-local-worker.mjs");
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
  assert.match(loop.text, /Done/);
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

await check("mac keys are key codes, and move and scroll post core graphics events", async () => {
  assert.match(macKeyScript("Return"), /key code 36$/);
  assert.doesNotMatch(macKeyScript("Return"), /keystroke|Return/);
  assert.match(macKeyScript("Tab"), /key code 48$/);
  assert.match(macKeyScript("Escape"), /key code 53$/);
  assert.match(macKeyScript("Delete"), /key code 51$/);
  assert.match(macKeyScript("Left"), /key code 123$/);
  assert.match(macKeyScript("Down"), /key code 125$/);
  assert.match(macKeyScript("cmd+c"), /key code 8 using \{command down\}/);
  assert.match(macKeyScript("ctrl+shift+Tab"), /key code 48 using \{control down, shift down\}/);
  assert.match(macKeyScript("alt+Left"), /key code 123 using \{option down\}/);
  assert.match(macKeyScript("shift+Return"), /key code 36 using \{shift down\}/);
  assert.match(macKeyScript("cmd+ctrl+alt+shift+Escape"), /key code 53 using \{command down, control down, option down, shift down\}/);
  assert.match(macKeyScript("a"), /key code 0$/);
  assert.match(macKeyScript("/"), /keystroke "\/"/);
  assert.throws(() => macKeyScript("ReturnKey"), /Unknown key/);
  const move = macPointerScript("/move", { x: 12, y: 34 });
  assert.match(move, /CGEventCreateMouseEvent/);
  assert.match(move, /CGPointMake\(12, 34\)/);
  assert.doesNotMatch(move, /CGEventCreateScrollWheelEvent/);
  const scroll = macPointerScript("/scroll", { x: 3, y: 4, scroll_y: 120, scroll_x: -40 });
  assert.match(scroll, /CGEventCreateMouseEvent/);
  assert.match(scroll, /CGEventCreateScrollWheelEvent\(src, 0, 2, -120, -40\)/);
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
  assert.match(text, /Done/);
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
            content: "Done.",
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
  assert.match(text, /Done/);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "move");
  assert.equal(workerAction(steps[0]).path, "/move");
  assert.equal(bash, false);
  assert.equal(screenResetPlan().shell, null);
  vision.server.close();
  worker.server.close();
});

await check("a repeated computer action stops the loop", async () => {
  clearHealth();
  let asked = 0;
  const worker = await startWorker({ bind: "127.0.0.1", port: 0, kind: "fake", token: "" });
  const vision = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3.8:27b-q8_0" }] });
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
  const text = await localComputerTurn("task-repeat", "move");
  assert.match(text, /same action repeated/);
  assert.equal(asked, 2);
  vision.server.close();
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
  assert.match(result.text, /Done/);
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
