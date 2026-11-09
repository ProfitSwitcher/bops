// Local-only mode must not ask Orgo or Google who the user is.
// Usage: node --conditions=react-server scripts/test-local-auth.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.BOPS_LOCAL_ONLY = "1";
for (const key of ["ORGO_API_KEY", "BOPS_DATABASE_URL", "BOPS_SELF_HOSTED"]) delete process.env[key];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
const project = pathToFileURL(root).href + "/";
const STAND_INS = new Set(["keychain", "cloud-tunnel", "relay", "sessions", "mac", "desktop", "mirror", "analytics"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    if (!url.startsWith(project) || url.includes("/node_modules/") || !/\.tsx?$/.test(url)) return next(url, context);
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name && STAND_INS.has(name)) {
      const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
    }
    const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const scratch = mkdtempSync(join(tmpdir(), "bops-local-auth-"));
process.chdir(scratch);
const calls = [];
globalThis.fetch = async (input) => {
  calls.push(String(input));
  throw new Error(`local-only mode called the network: ${input}`);
};

const { authStatus, startSignIn, pollSignIn } = await import(`${root}/lib/server/orgo-sign-in.ts`);
const status = await authStatus();
assert.equal(status.needsSignIn, false);
assert.equal(status.signedIn, true);
assert.equal(status.user.id, "local");
assert.equal(status.cloudProblem, false);
await assert.rejects(startSignIn("google"), /does not sign in with Orgo, Google, or email/);
await assert.rejects(startSignIn("email"), /does not sign in with Orgo, Google, or email/);
await assert.rejects(startSignIn(), /does not sign in with Orgo, Google, or email/);
const polled = await pollSignIn();
assert.equal(polled.status, "approved");
assert.equal(polled.user.id, "local");
assert.equal(calls.length, 0);
rmSync(scratch, { recursive: true, force: true });
console.log("ok  local-only skips Orgo, Google, and email sign-in");
