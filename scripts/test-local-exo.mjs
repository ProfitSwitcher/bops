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

const { modelsFromExoState, inProgressDownloads, chooseExoPlacement, exoWarmup, resetExoForTests } = await import("../lib/local/exo.ts");
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
const card = (id) => ({ modelId: id, backends: ["MlxMetal"], storageSize: { inBytes: 10 }, nLayers: 1, hiddenSize: 1, supportsTensor: true, tasks: ["TextGeneration"] });
const shard = (id) => ({ PipelineShardMetadata: { modelCard: card(id), deviceRank: 0, worldSize: 1, startLayer: 0, endLayer: 1, nLayers: 1 } });
function readyInstance(model, id = "inst-kimi") {
  return {
    instances: {
      [id]: { MlxRingInstance: { instanceId: id, shardAssignments: { modelId: model, runnerToShard: { r1: {} }, nodeToRunner: { studio1: "r1" } } } },
    },
    runners: { r1: { RunnerReady: {} } },
  };
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
const done = (id, node = "studio1") => ({ DownloadCompleted: { nodeId: node, shardMetadata: shard(id), total: { inBytes: 10 } } });
const pending = (id, node) => ({ DownloadPending: { nodeId: node, shardMetadata: shard(id) } });
const KIMI = "mlx-community/Kimi-K2.7-Code-4bit";
function preview(model, sharding, instanceMeta, nodes) {
  const nodeToRunner = Object.fromEntries(nodes.map((node, i) => [node, `runner-${i}`]));
  return { modelId: model, sharding, instanceMeta, instance: { shardAssignments: { modelId: model, nodeToRunner, runnerToShard: nodeToRunner } }, error: null };
}
const busy = (id) => ({ DownloadOngoing: { nodeId: "studio3", shardMetadata: { TensorShardMetadata: { modelCard: card(id), deviceRank: 0, worldSize: 1, startLayer: 0, endLayer: 1, nLayers: 1 } }, downloadProgress: { downloaded: { inBytes: 1 }, total: { inBytes: 10 }, downloadedThisSession: { inBytes: 1 }, completedFiles: 1, totalFiles: 4, speed: 1, etaMs: 1, files: {} } } });

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
  const leftover = modelsFromExoState({
    downloads: { studio1: [done(KIMI, "studio1")], studio3: [pending(KIMI, "studio3")] },
  });
  assert.deepEqual(leftover.downloaded, [KIMI]);
  assert.deepEqual(leftover.downloading, []);
});

await check("exo 0.3.70 state and previews still parse, including backends and node ids", async () => {
  const studio1 = "4f2c0a1e-7b6d-4e1a-9c33-0a1b2c3d4e5f";
  const studio3 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const big = "mlx-community/DeepSeek-V4-Flash";
  const ongoing = busy(big);
  ongoing.DownloadOngoing.nodeId = studio3;
  const inventory = modelsFromExoState({
    nodeBackends: { [studio1]: ["MlxMetal"], [studio3]: ["MlxMetal"] },
    downloads: { [studio1]: [done(KIMI, studio1)], [studio3]: [ongoing] },
  });
  assert.deepEqual(inventory.downloaded, [KIMI]);
  assert.deepEqual(inventory.downloading, [big]);
  const progress = inProgressDownloads({ downloads: { [studio3]: [ongoing] } });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].node, studio3);
  assert.equal(progress[0].model, big);
  assert.deepEqual(progress[0].shard.TensorShardMetadata.modelCard.backends, ["MlxMetal"]);
  const choice = chooseExoPlacement(
    {
      previews: [
        {
          model_id: KIMI,
          sharding: "Tensor",
          instance_meta: "MlxJaccl",
          instance: {
            MlxJacclInstance: {
              instanceId: "preview-1",
              shardAssignments: { modelId: KIMI, nodeToRunner: { [studio1]: "r1", [studio3]: "r2" }, runnerToShard: { r1: {}, r2: {} } },
            },
          },
          memory_delta_by_node: { [studio1]: 10, [studio3]: 10 },
          error: null,
        },
      ],
    },
    [studio1, studio3],
  );
  assert.equal(choice.sharding, "Tensor");
  assert.equal(choice.instance_meta, "MlxJaccl");
  assert.deepEqual(choice.nodes.sort(), [studio1, studio3].sort());
});

await check("heavy uses a downloaded exo model and never asks for one that is still downloading", async () => {
  resetExoForTests();
  clearHealth();
  const seen = [];
  const exo = await listen(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/state") {
      return json(res, {
        downloads: { studio1: [done("mlx-community/Kimi-K2.7-Code-4bit"), busy("GLM-5.3-Flash")] },
        ...readyInstance("mlx-community/Kimi-K2.7-Code-4bit"),
      });
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
  assert.equal(seen.some((u) => u.includes("/models/search") || u.includes("/models/add") || u.includes("/v1/models") || u.includes("/place_instance")), false);
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

await check("a missing exo instance is placed across both nodes, then polled until ready", async () => {
  resetExoForTests();
  clearHealth();
  process.env.BOPS_EXO_LOAD_TIMEOUT_MS = "3000";
  delete process.env.BOPS_EXO_ALLOW_EVICT;
  const placed = [];
  let polls = 0;
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/state") {
      polls += 1;
      const runners = polls < 3 ? { r1: { RunnerLoading: {} } } : { r1: { RunnerReady: {} } };
      const instances = placed.length
        ? { inst1: { MlxJacclInstance: { instanceId: "inst1", shardAssignments: { modelId: KIMI, runnerToShard: { r1: {} }, nodeToRunner: { studio1: "r1", studio3: "r1" } } } } }
        : {};
      return json(res, { downloads: { studio1: [done(KIMI, "studio1")], studio3: [done(KIMI, "studio3")] }, instances, runners });
    }
    if (path === "/instance/previews") {
      return json(res, { previews: [preview(KIMI, "Tensor", "MlxJaccl", ["studio1", "studio3"]), preview(KIMI, "Pipeline", "MlxRing", ["studio1"])] });
    }
    if (req.method === "POST" && path === "/place_instance") {
      placed.push(await readBody(req));
      return json(res, { message: "Command received." });
    }
    if (req.url === "/v1/chat/completions") return json(res, { choices: [{ message: { content: "placed" } }] });
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: KIMI }] } },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "write it" }] });
  assert.equal(result.content, "placed");
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0], { model_id: KIMI, sharding: "Tensor", instance_meta: "MlxJaccl", min_nodes: 2 });
  clearHealth();
  const again = await chat({ role: "heavy", messages: [{ role: "user", content: "again" }] });
  assert.equal(again.content, "placed");
  assert.equal(placed.length, 1);
  exo.server.close();
});

await check("a model complete on one node is not placed onto a node that only has DownloadPending", async () => {
  clearHealth();
  resetExoForTests();
  process.env.BOPS_EXO_LOAD_TIMEOUT_MS = "3000";
  const placed = [];
  let ready = false;
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/state") {
      return json(res, {
        downloads: { studio1: [done(KIMI, "studio1")], studio3: [pending(KIMI, "studio3")] },
        instances: ready ? { inst1: { MlxRingInstance: { instanceId: "inst1", shardAssignments: { modelId: KIMI, runnerToShard: { r1: {} }, nodeToRunner: { studio1: "r1" } } } } } : {},
        runners: { r1: { RunnerReady: {} } },
      });
    }
    if (path === "/instance/previews") {
      return json(res, { previews: [preview(KIMI, "Tensor", "MlxJaccl", ["studio1", "studio3"]), preview(KIMI, "Pipeline", "MlxRing", ["studio1"])] });
    }
    if (req.method === "POST" && path === "/place_instance") {
      const body = await readBody(req);
      placed.push(body);
      ready = true;
      return json(res, { message: "Command received." });
    }
    if (path === "/v1/chat/completions") return json(res, { choices: [{ message: { content: "studio1 only" } }] });
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: KIMI }] } },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "write it" }] });
  assert.equal(result.content, "studio1 only");
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0], { model_id: KIMI, sharding: "Pipeline", instance_meta: "MlxRing", min_nodes: 1 });
  exo.server.close();
});

await check("no placement is sent when every preview would download the model", async () => {
  clearHealth();
  const calls = [];
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    calls.push(`${req.method} ${path}`);
    if (path === "/state") return json(res, { downloads: { studio1: [done(KIMI, "studio1")], studio3: [pending(KIMI, "studio3")] }, instances: {}, runners: {} });
    if (path === "/instance/previews") return json(res, { previews: [preview(KIMI, "Tensor", "MlxJaccl", ["studio1", "studio3"])] });
    if (req.method === "POST" && path === "/place_instance") return json(res, { error: "should not place" }, 500);
    json(res, { error: "unexpected" }, 500);
  });
  const ollama = await listen((req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    json(res, { choices: [{ message: { content: "planner fallback" } }] });
  });
  useConfig({
    llm: {
      endpoints: [
        { id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" },
        { id: "studio3", baseUrl: `${ollama.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] },
        heavy: { chain: [{ endpoint: "exo", model: KIMI }, { endpoint: "studio3", model: "ornith-1.5:122b" }] },
      },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "plan" }] });
  assert.equal(result.content, "planner fallback");
  assert.match(result.degraded ?? "", /Not placing it/);
  assert.equal(calls.some((c) => c.startsWith("POST /place_instance")), false);
  exo.server.close();
  ollama.server.close();
});

await check("a running exo instance that will not fit is left alone, and heavy falls through", async () => {
  clearHealth();
  delete process.env.BOPS_EXO_ALLOW_EVICT;
  const calls = [];
  const exo = await listen(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/state") {
      return json(res, {
        downloads: { studio1: [done("MiniMaxAI/MiniMax-M2.7"), done("mlx-community/Kimi-K2.7-Code-4bit")] },
        instances: { big: { MlxRingInstance: { instanceId: "big", shardAssignments: { modelId: "mlx-community/Kimi-K2.7-Code-4bit", runnerToShard: { r1: {} }, nodeToRunner: { studio1: "r1" } } } } },
        runners: { r1: { RunnerRunning: {} } },
      });
    }
    if (req.method === "POST" && req.url === "/place_instance") return json(res, { detail: "No cycles found with sufficient memory" }, 400);
    if (req.method === "DELETE") return json(res, { error: "should not evict" }, 500);
    json(res, { error: "unexpected" }, 500);
  });
  const ollama = await listen((req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    json(res, { choices: [{ message: { content: "planner fallback" } }] });
  });
  useConfig({
    llm: {
      endpoints: [
        { id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" },
        { id: "studio3", baseUrl: `${ollama.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] },
        heavy: { chain: [{ endpoint: "exo", model: "MiniMaxAI/MiniMax-M2.7" }, { endpoint: "studio3", model: "ornith-1.5:122b" }] },
      },
    },
    workers: [],
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "plan" }] });
  assert.equal(result.content, "planner fallback");
  assert.equal(result.model, "ornith-1.5:122b");
  assert.match(result.degraded ?? "", /Eviction is off/);
  assert.equal(calls.some((c) => c.startsWith("DELETE")), false);
  exo.server.close();
  ollama.server.close();
});

await check("eviction stays off unless the config allows it", async () => {
  clearHealth();
  const calls = [];
  let placed = false;
  const exo = await listen(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/state") {
      return json(res, {
        downloads: { studio1: [done("MiniMaxAI/MiniMax-M2.7"), done("mlx-community/Kimi-K2.7-Code-4bit")] },
        instances: placed
          ? { next: { MlxRingInstance: { instanceId: "next", shardAssignments: { modelId: "MiniMaxAI/MiniMax-M2.7", runnerToShard: { r2: {} }, nodeToRunner: { studio3: "r2" } } } } }
          : { big: { MlxRingInstance: { instanceId: "big", shardAssignments: { modelId: "mlx-community/Kimi-K2.7-Code-4bit", runnerToShard: { r1: {} }, nodeToRunner: { studio1: "r1" } } } } },
        runners: { r1: { RunnerReady: {} }, r2: { RunnerReady: {} } },
      });
    }
    if (req.method === "DELETE" && req.url === "/instance/big") return json(res, { ok: true });
    if (req.method === "POST" && req.url === "/place_instance") {
      if (!calls.some((c) => c.startsWith("DELETE"))) return json(res, { detail: "No cycles found with sufficient memory" }, 400);
      placed = true;
      return json(res, { message: "Command received." });
    }
    if (req.url === "/v1/chat/completions") return json(res, { choices: [{ message: { content: "after evict" } }] });
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: "MiniMaxAI/MiniMax-M2.7" }] } },
    },
    workers: [],
    exo: { allowEvict: true },
  });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "go" }] });
  assert.equal(result.content, "after evict");
  assert.ok(calls.includes("DELETE /instance/big"));
  exo.server.close();
});

function failedInstance(id, model) {
  return { MlxRingInstance: { instanceId: id, shardAssignments: { modelId: model, runnerToShard: { [id]: {} }, nodeToRunner: { studio1: id } } } };
}

await check("a runner failure deletes only the instance this attempt created", async () => {
  resetExoForTests();
  clearHealth();
  process.env.BOPS_EXO_LOAD_TIMEOUT_MS = "10000";
  const deleted = [];
  const starts = [];
  let placed = false;
  let cancelled = false;
  let resumed = false;
  const node = "4f2c0a1e-7b6d-4e1a-9c33-0a1b2c3d4e5f";
  const big = "mlx-community/DeepSeek-V4-Flash";
  const bigShard = shard(big);
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/state") {
      const instances = { "keep-me": failedInstance("keep-me", "other-model") };
      const runners = { "keep-me": { RunnerReady: {} } };
      if (placed) {
        instances["inst-new"] = failedInstance("inst-new", KIMI);
        runners["inst-new"] = { RunnerFailed: { errorMessage: "Model type deepseek_v4 not supported" } };
      }
      const downloads = { [node]: [done(KIMI, node)] };
      if (!cancelled || resumed) downloads[node].push({ DownloadOngoing: { nodeId: node, shardMetadata: bigShard, downloadProgress: { total: { inBytes: 100 }, downloaded: { inBytes: 40 }, downloadedThisSession: { inBytes: 10 }, completedFiles: 2, totalFiles: 8, speed: 1, etaMs: 5, files: {} } } });
      return json(res, { downloads, instances, runners });
    }
    if (path === "/instance/previews") return json(res, { previews: [preview(KIMI, "Pipeline", "MlxRing", [node])] });
    if (req.method === "POST" && path === "/place_instance") {
      placed = true;
      return json(res, { message: "Command received." });
    }
    if (req.method === "POST" && path === "/download/start") {
      starts.push(await readBody(req));
      resumed = true;
      return json(res, { commandId: "dl-1" });
    }
    if (req.method === "DELETE") {
      deleted.push(path);
      cancelled = true;
      return json(res, { ok: true });
    }
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: KIMI }] } },
    },
    workers: [],
  });
  const started = Date.now();
  await assert.rejects(chat({ role: "heavy", messages: [{ role: "user", content: "write" }] }), /Model type deepseek_v4 not supported/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(deleted, ["/instance/inst-new"]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].targetNodeId, node);
  assert.equal(starts[0].modelId, undefined);
  assert.equal(starts[0].shardMetadata.PipelineShardMetadata.modelCard.modelId, big);
  assert.deepEqual(starts[0].shardMetadata.PipelineShardMetadata.modelCard.backends, ["MlxMetal"]);
  exo.server.close();
});

await check("cleanup says so when a cancelled download does not resume", async () => {
  resetExoForTests();
  clearHealth();
  process.env.BOPS_EXO_LOAD_TIMEOUT_MS = "1000";
  let placed = false;
  let cancelled = false;
  const node = "4f2c0a1e-7b6d-4e1a-9c33-0a1b2c3d4e5f";
  const big = "mlx-community/DeepSeek-V4-Flash";
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/state") {
      const instances = {};
      const runners = {};
      if (placed) {
        instances["inst-new"] = failedInstance("inst-new", KIMI);
        runners["inst-new"] = { RunnerFailed: { errorMessage: "Model type deepseek_v4 not supported" } };
      }
      const downloads = { [node]: [done(KIMI, node)] };
      if (!cancelled) downloads[node].push({ DownloadOngoing: { nodeId: node, shardMetadata: shard(big), downloadProgress: { total: { inBytes: 10 }, downloaded: { inBytes: 1 }, downloadedThisSession: { inBytes: 1 }, completedFiles: 0, totalFiles: 1, speed: 1, etaMs: 1, files: {} } } });
      return json(res, { downloads, instances, runners });
    }
    if (path === "/instance/previews") return json(res, { previews: [preview(KIMI, "Pipeline", "MlxRing", [node])] });
    if (req.method === "POST" && path === "/place_instance") {
      placed = true;
      return json(res, { message: "Command received." });
    }
    if (req.method === "POST" && path === "/download/start") return json(res, { commandId: "dl-1" });
    if (req.method === "DELETE") {
      cancelled = true;
      return json(res, { ok: true });
    }
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: KIMI }] } },
    },
    workers: [],
  });
  await assert.rejects(chat({ role: "heavy", messages: [{ role: "user", content: "write" }] }), /downloads not resumed: mlx-community\/DeepSeek-V4-Flash/);
  exo.server.close();
});

await check("an instance that was already running is not deleted when its runner has failed", async () => {
  resetExoForTests();
  clearHealth();
  const calls = [];
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    calls.push(`${req.method} ${path}`);
    if (path === "/state") {
      return json(res, {
        downloads: { studio1: [done(KIMI, "studio1")] },
        instances: { "inst-old": failedInstance("inst-old", KIMI) },
        runners: { "inst-old": { RunnerFailed: { errorMessage: "Model type deepseek_v4 not supported" } } },
      });
    }
    json(res, { error: "unexpected" }, 500);
  });
  useConfig({
    llm: {
      endpoints: [{ id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" }],
      roles: { planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] }, heavy: { chain: [{ endpoint: "exo", model: KIMI }] } },
    },
    workers: [],
  });
  await assert.rejects(chat({ role: "heavy", messages: [{ role: "user", content: "write" }] }), /deepseek_v4/);
  assert.equal(calls.some((c) => c.startsWith("DELETE") || c.startsWith("POST /place_instance")), false);
  exo.server.close();
});

await check("a placement that never becomes ready is deleted, and exo is then skipped", async () => {
  resetExoForTests();
  clearHealth();
  process.env.BOPS_EXO_LOAD_TIMEOUT_MS = "1000";
  const placed = [];
  const deleted = [];
  let seq = 0;
  const live = new Set();
  const exo = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/state") {
      const instances = {};
      const runners = {};
      for (const id of live) {
        instances[id] = failedInstance(id, KIMI);
        runners[id] = { RunnerIdle: {} };
      }
      return json(res, { downloads: { studio1: [done(KIMI, "studio1")] }, instances, runners });
    }
    if (path === "/instance/previews") return json(res, { previews: [preview(KIMI, "Pipeline", "MlxRing", ["studio1"])] });
    if (req.method === "POST" && path === "/place_instance") {
      seq += 1;
      const id = `inst-${seq}`;
      live.add(id);
      placed.push(id);
      return json(res, { message: "Command received." });
    }
    if (req.method === "DELETE") {
      const id = decodeURIComponent(path.split("/").pop());
      live.delete(id);
      deleted.push(id);
      return json(res, { ok: true });
    }
    json(res, { error: "unexpected" }, 500);
  });
  const ollama = await listen((req, res) => {
    if (req.url === "/api/tags") return json(res, { models: [{ name: "ornith-1.5:122b" }] });
    json(res, { choices: [{ message: { content: "planner fallback" } }] });
  });
  const heavy = {
    llm: {
      endpoints: [
        { id: "exo", baseUrl: `${exo.url}/v1`, provider: "exo", apiKey: "" },
        { id: "studio3", baseUrl: `${ollama.url}/v1`, provider: "ollama", apiKey: "" },
      ],
      roles: {
        planner: { chain: [] }, fast: { chain: [] }, vision: { chain: [] }, embed: { chain: [] },
        heavy: { chain: [{ endpoint: "exo", model: KIMI }, { endpoint: "studio3", model: "ornith-1.5:122b" }] },
      },
    },
    workers: [],
  };
  useConfig(heavy);
  const first = await chat({ role: "heavy", messages: [{ role: "user", content: "one" }] });
  clearHealth();
  const second = await chat({ role: "heavy", messages: [{ role: "user", content: "two" }] });
  clearHealth();
  const third = await chat({ role: "heavy", messages: [{ role: "user", content: "three" }] });
  assert.equal(first.content, "planner fallback");
  assert.equal(second.content, "planner fallback");
  assert.equal(third.content, "planner fallback");
  assert.match(first.degraded ?? "", /did not become ready/);
  assert.match(third.degraded ?? "", /skipped/);
  assert.deepEqual(placed, ["inst-1", "inst-2"]);
  assert.deepEqual(deleted, ["inst-1", "inst-2"]);
  exo.server.close();
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
