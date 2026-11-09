// Local-only provider, routing, memory, worker, and the egress tripwire.
// Usage: node --experimental-strip-types scripts/test-local.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const { parseConfig, useConfig, loadConfig, localOnly } = await import("../lib/local/mode.ts");
const { clearHealth, withRole, checkEndpoint } = await import("../lib/local/endpoints.ts");
const { chat, embed, looseToolCalls } = await import("../lib/local/provider.ts");
const { runResponses, resetResponsesForTests } = await import("../lib/local/responses.ts");
const { runComputerUseLoop } = await import("../lib/local/computer-use.ts");
const { addFacts, searchFacts, closeMemoryForTests, memoryDb } = await import("../lib/local/memory-store.ts");
const { installEgressGuard, LocalOnlyError, refusedConnections } = await import("../lib/local/egress.mjs");
const { startWorker, refuseBind } = await import("../workers/bops-local-worker.mjs");
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
  useConfig(null);
  const cfg = loadConfig();
  assert.equal(cfg.llm.roles.planner.chain[0].model, "ornith-1.5:122b");
  assert.equal(cfg.llm.roles.planner.chain[1].model, "qwen3.8-flash-next:125b-mlx");
  assert.equal(cfg.llm.roles.planner.chain[2].model, "qwen3.5:122b");
  assert.equal(cfg.llm.roles.vision.chain[0].model, "qwen3.8:27b-q8_0");
  assert.equal(cfg.llm.roles.vision.chain.find((s) => s.endpoint === "geforce5").quant, "q4_K_M");
  assert.equal(cfg.llm.roles.fast.chain.at(-1).model, "qwen3:4b");
  assert.equal(cfg.llm.roles.embed.chain[0].model, "qwen3-embedding:8b");
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
