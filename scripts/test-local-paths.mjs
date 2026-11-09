// The standalone server must not read .data or bops.local.json copied beside it.
// Usage: node --experimental-strip-types scripts/test-local-paths.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const root = mkdtempSync(join(tmpdir(), "bops-repo-"));
const standalone = join(root, ".next", "standalone");
mkdirSync(join(standalone, ".data"), { recursive: true });
mkdirSync(join(root, ".data"), { recursive: true });
const repoConfig = {
  llm: {
    endpoints: [{ id: "studio3", baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama", apiKey: "" }],
    roles: { planner: { chain: [{ endpoint: "studio3", model: "from-repo" }] } },
  },
  workers: [],
};
const staleConfig = {
  llm: {
    endpoints: [{ id: "studio3", baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama", apiKey: "stale-token" }],
    roles: { planner: { chain: [{ endpoint: "studio3", model: "from-standalone" }] } },
  },
  workers: [],
};
writeFileSync(join(root, "bops.local.json"), JSON.stringify(repoConfig));
writeFileSync(join(standalone, "bops.local.json"), JSON.stringify(staleConfig));
writeFileSync(join(standalone, ".data", "cloud-keys.json"), JSON.stringify({ openai: "stale-token" }));
writeFileSync(join(root, ".data", "marker"), "live");

process.chdir(standalone);
for (const key of ["BOPS_LLM_PLANNER_MODEL", "BOPS_LLM_FAST_MODEL", "BOPS_LLM_VISION_MODEL", "BOPS_LLM_EMBED_MODEL", "BOPS_LLM_HEAVY_MODEL", "BOPS_REPO_ROOT"]) delete process.env[key];
process.env.BOPS_DATA_DIR = join(root, ".data");
process.env.BOPS_LOCAL_CONFIG = join(root, "bops.local.json");
process.env.BOPS_CLOUD_HOME = "";
delete process.env.BOPS_CLOUD_KEY_STORE;

const { dataRoot } = await import("../lib/server/user-paths.ts");
const { loadConfig, useConfig } = await import("../lib/local/mode.ts");

useConfig(null);
assert.equal(dataRoot(), join(root, ".data"));
assert.equal(readFileSync(join(dataRoot(), "marker"), "utf8"), "live");
const cfg = loadConfig();
assert.equal(cfg.llm.roles.planner.chain[0].model, "from-repo");
assert.equal(cfg.llm.endpoints[0].apiKey, "");
assert.equal(JSON.stringify(cfg).includes("stale-token"), false);

const tracing = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
assert.match(tracing, /bops\.local\.json/);
assert.match(tracing, /\.data/);

rmSync(root, { recursive: true, force: true });
console.log("ok  standalone data and config stay at the repo root");
