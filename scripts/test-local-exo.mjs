// exo download filter, heavy-role failover, and warm-up status.
// Usage: node --experimental-strip-types scripts/test-local-exo.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";

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
for (const key of ["BOPS_LLM_HEAVY_MODEL", "BOPS_LLM_PLANNER_MODEL", "BOPS_LOCAL_CONFIG"]) delete process.env[key];

const { modelsFromExoState, exoWarmup, resetExoForTests } = await import("../lib/local/exo.ts");
const { useConfig } = await import("../lib/local/mode.ts");
const { clearHealth } = await import("../lib/local/endpoints.ts");
const { chat } = await import("../lib/local/provider.ts");
const { roleFor } = await import("../lib/local/responses.ts");

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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const shard = (id) => ({ PipelineShardMetadata: { modelCard: { modelId: id } } });
const done = (id) => ({ DownloadCompleted: { nodeId: "studio1", shardMetadata: shard(id), total: { inBytes: 10 } } });
const busy = (id) => ({ DownloadOngoing: { nodeId: "studio3", shardMetadata: { TensorShardMetadata: { modelCard: { modelId: id } } }, downloadProgress: { downloaded: { inBytes: 1 }, total: { inBytes: 10 } } } });

await check("only DownloadCompleted models count, and a download still in progress does not", async () => {
  const inventory = modelsFromExoState({
    downloads: {
      studio1: [done("mlx-community/Kimi-K2.7-Code-4bit"), done("GLM-5.3-Flash"), busy("GLM-5.3-Flash")],
      studio3: [done("Qwen3-Coder-480B-8bit"), busy("MiniMax-M2.7")],
    },
  });
  assert.deepEqual(inventory.downloaded.sort(), ["Qwen3-Coder-480B-8bit", "mlx-community/Kimi-K2.7-Code-4bit"]);
  assert.ok(inventory.downloading.includes("GLM-5.3-Flash"));
  assert.ok(inventory.downloading.includes("MiniMax-M2.7"));
  const oneNode = modelsFromExoState({
    downloads: { studio1: [done("mlx-community/Kimi-K2.7-Code-4bit")], studio3: [] },
  });
  assert.deepEqual(oneNode.downloaded, ["mlx-community/Kimi-K2.7-Code-4bit"]);
});

await check("heavy uses a downloaded exo model and never asks for one that is still downloading", async () => {
  resetExoForTests();
  clearHealth();
  const seen = [];
  const exo = await listen(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/state") {
      return json(res, { downloads: { studio1: [done("mlx-community/Kimi-K2.7-Code-4bit"), busy("GLM-5.3-Flash")] } });
    }
    if (req.url === "/v1/models") return json(res, { object: "list", data: Array.from({ length: 92 }, (_, i) => ({ id: `catalog-${i}` })) });
    if (req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      seen.push(`model ${body.model}`);
      assert.equal(exoWarmup()?.model, body.model);
      return json(res, { choices: [{ message: { content: "from exo" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    json(res, { error: "unexpected" }, 500);
  });
  const ollama = await listen((req, res) => {
    seen.push(`ollama ${req.url}`);
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    json(res, { choices: [{ message: { content: "from ollama" } }] });
  });
  useConfig({
    llm: {
      endpoints: [
        { id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" },
        { id: "studio3", baseUrl: `${ollama.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] },
        fast: { chain: [] },
        vision: { chain: [] },
        embed: { chain: [] },
        heavy: {
          chain: [
            { endpoint: "exo", model: "GLM-5.3-Flash" },
            { endpoint: "exo", model: "mlx-community/Kimi-K2.7-Code-4bit" },
            { endpoint: "studio3", model: "ornith-1.5:122b" },
          ],
        },
      },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "plan this" }] });
  assert.equal(result.content, "from exo");
  assert.equal(result.model, "mlx-community/Kimi-K2.7-Code-4bit");
  assert.equal(result.endpoint, "exo");
  assert.match(result.degraded ?? "", /still downloading/);
  assert.equal(seen.some((u) => u.includes("GLM-5.3-Flash")), false);
  assert.equal(seen.some((u) => u.includes("/models/search") || u.includes("/models/add") || u.includes("/v1/models")), false);
  assert.equal(exoWarmup(), null);
  exo.server.close();
  ollama.server.close();
});

await check("exo down falls through to the Ollama planner", async () => {
  clearHealth();
  const ollama = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    json(res, { choices: [{ message: { content: "planner fallback" } }] });
  });
  useConfig({
    llm: {
      endpoints: [
        { id: "exo", baseUrl: "http://127.0.0.1:1/v1", provider: "exo", apiKey: "" },
        { id: "studio3", baseUrl: `${ollama.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: { chain: [] },
        fast: { chain: [] },
        vision: { chain: [] },
        embed: { chain: [] },
        heavy: {
          chain: [
            { endpoint: "exo", model: "mlx-community/Kimi-K2.7-Code-4bit" },
            { endpoint: "studio3", model: "ornith-1.5:122b" },
          ],
        },
      },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "plan" }] });
  assert.equal(result.content, "planner fallback");
  assert.equal(result.model, "ornith-1.5:122b");
  assert.match(result.degraded ?? "", /exo/);
  ollama.server.close();
});

await check("a high-effort turn is heavy, and computer use stays on vision", async () => {
  assert.equal(roleFor({ reasoning: { effort: "high" }, input: "design the migration" }), "heavy");
  assert.equal(roleFor({ reasoning: { effort: "high" }, tools: [{ type: "computer" }], input: "click save" }), "vision");
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nexo tests passed");
