// Optional cloud keys stay off in the default local-only mode.
// Usage: node --experimental-strip-types scripts/test-local-cloud.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
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

const home = mkdtempSync(join(tmpdir(), "bops-cloud-"));
process.env.BOPS_LOCAL_ONLY = "1";
process.env.BOPS_CLOUD_HOME = home;
process.env.BOPS_CLOUD_KEY_STORE = "file";
for (const key of ["BOPS_LLM_HEAVY_MODEL", "BOPS_LLM_PLANNER_MODEL", "BOPS_LOCAL_CONFIG"]) delete process.env[key];

const { saveCloudKey, removeCloudKey, setCloudPolicy, cloudPlan, resetCloudForTests, cloudKeyFile, tryCloudChat, redactSecrets } = await import("../lib/local/cloud.ts");
const { useConfig } = await import("../lib/local/mode.ts");
const { clearHealth } = await import("../lib/local/endpoints.ts");
const { chat } = await import("../lib/local/provider.ts");
const { installEgressGuard, setCloudAllowlist, pinCloudIp, cloudAllowlist, LocalOnlyError, nameAllowed } = await import("../lib/local/egress.mjs");

const SECRET = "sk-test-cloud-key-not-real";
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

resetCloudForTests();

await check("a saved key is mode 0600 and cloud stays off until Allow cloud models is on", async () => {
  await saveCloudKey("openai", SECRET);
  assert.equal(statSync(cloudKeyFile()).mode & 0o777, 0o600);
  setCloudPolicy({ allow: false, roles: { heavy: { mode: "fallback", provider: "openai", model: "gpt-test" } } });
  assert.equal(cloudPlan("heavy"), null);
  setCloudPolicy({ allow: true, roles: { heavy: { mode: "fallback", provider: "openai", model: "gpt-test" } } });
  await removeCloudKey("openai");
  assert.equal(cloudPlan("heavy"), null);
  await saveCloudKey("openai", SECRET);
  assert.equal(cloudPlan("heavy"), "fallback");
});

function localDown() {
  clearHealth();
  useConfig({
    llm: {
      endpoints: [{ id: "studio3", baseUrl: "http://127.0.0.1:1/v1", provider: "ollama", apiKey: "" }],
      roles: {
        planner: { chain: [] },
        fast: { chain: [] },
        vision: { chain: [] },
        embed: { chain: [] },
        heavy: { chain: [{ endpoint: "studio3", model: "ornith-1.5:122b" }] },
      },
    },
    workers: [],
  });
}

await check("no cloud call unless that role's fallback is explicitly on", async () => {
  const hosts = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    hosts.push(url.host);
    if (url.host === "api.openai.com") return Response.json({ choices: [{ message: { content: "from openai" } }] });
    return new Response("down", { status: 500 });
  };
  localDown();
  setCloudPolicy({ allow: true, roles: { heavy: { mode: "off", provider: "openai", model: "gpt-test" } } });
  await assert.rejects(() => chat({ role: "heavy", messages: [{ role: "user", content: "plan" }], fetchImpl }));
  assert.equal(hosts.includes("api.openai.com"), false);

  hosts.length = 0;
  setCloudPolicy({ allow: true, roles: { heavy: { mode: "fallback", provider: "openai", model: "gpt-test" } } });
  const result = await chat({ role: "heavy", messages: [{ role: "user", content: "plan" }], fetchImpl });
  assert.equal(result.content, "from openai");
  assert.equal(result.cloud?.provider, "openai");
  assert.deepEqual(hosts.filter((h) => h === "api.openai.com"), ["api.openai.com"]);
});

await check("a key in a provider error is not shown", async () => {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  setCloudPolicy({ allow: true, roles: { heavy: { mode: "prefer", provider: "openai", model: "gpt-test" } } });
  let message = "";
  try {
    await tryCloudChat({
      role: "heavy",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => {
        throw new Error(`unauthorized ${SECRET}`);
      },
    });
  } catch (e) {
    message = (e).message;
  } finally {
    console.error = orig;
  }
  assert.equal(message.includes(SECRET), false);
  assert.match(message, /\[key\]/);
  assert.equal(logs.join("\n").includes(SECRET), false);
  assert.equal(redactSecrets(`token ${SECRET} end`).includes(SECRET), false);
});

await check("default mode still refuses public hosts, and the allowlist is only the enabled provider", async () => {
  resetCloudForTests();
  installEgressGuard();
  await assert.rejects(fetch("https://api.openai.com/v1/models"), LocalOnlyError);
  await assert.rejects(fetch("https://api.x.ai/v1/models"), LocalOnlyError);
  await new Promise((resolve, reject) => {
    const socket = net.connect(9, "1.1.1.1");
    socket.on("error", (e) => (e instanceof LocalOnlyError ? resolve() : reject(e)));
    socket.on("connect", () => reject(new Error("a public address connected")));
  });

  setCloudAllowlist(["api.openai.com"]);
  assert.deepEqual(cloudAllowlist(), ["api.openai.com"]);
  assert.equal(nameAllowed("api.openai.com"), true);
  assert.equal(nameAllowed("api.anthropic.com"), false);
  assert.equal(nameAllowed("api.x.ai"), false);
  assert.equal(nameAllowed("example.com"), false);
  assert.equal(pinCloudIp("api.openai.com", "203.0.113.10"), true);
  assert.equal(pinCloudIp("api.anthropic.com", "203.0.113.11"), false);
  const { egressPermits } = await import("../lib/local/egress.mjs");
  assert.equal(egressPermits("api.openai.com"), true);
  assert.equal(egressPermits("203.0.113.10"), true);
  assert.equal(egressPermits("203.0.113.11"), false);
  assert.equal(egressPermits("1.1.1.1"), false);
  await assert.rejects(fetch("https://api.anthropic.com/v1/models"), LocalOnlyError);
});

rmSync(home, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\ncloud tests passed");
