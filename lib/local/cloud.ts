/**
 * Optional bring-your-own-key cloud models. Off unless the owner turns
 * "Allow cloud models" on and a key is stored for that provider. A role uses
 * one only when that role is set to prefer it, or to fall back after every
 * local model has failed. Keys are never put in errors or logs.
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { setCloudAllowlist } from "./egress.mjs";
import type { ChatMessage, ChatResult, ToolDef } from "./provider";
import type { Role } from "./mode";

export type CloudProviderId = "xai" | "openai" | "anthropic";
export type CloudMode = "off" | "prefer" | "fallback";

export type CloudChoice = { mode: CloudMode; provider?: CloudProviderId; model?: string };

type Policy = { allow: boolean; roles: Partial<Record<Role, CloudChoice>> };

const PROVIDERS: Record<CloudProviderId, { name: string; host: string }> = {
  xai: { name: "xAI Grok", host: "api.x.ai" },
  openai: { name: "OpenAI", host: "api.openai.com" },
  anthropic: { name: "Anthropic", host: "api.anthropic.com" },
};

const ROLES: Role[] = ["planner", "fast", "vision", "embed", "heavy"];

let policy: Policy = { allow: false, roles: {} };
let loaded = false;
const keys = new Map<CloudProviderId, string>();
let lastCloud: { provider: CloudProviderId; name: string; model: string; role: Role; at: number } | null = null;

export function cloudProviders() {
  return (Object.keys(PROVIDERS) as CloudProviderId[]).map((id) => ({ id, ...PROVIDERS[id], hasKey: keys.has(id) }));
}

export function cloudPolicy(): Policy {
  load();
  return { allow: policy.allow, roles: { ...policy.roles } };
}

export function lastCloudAnswer() {
  return lastCloud ? { ...lastCloud } : null;
}

export function resetCloudForTests() {
  policy = { allow: false, roles: {} };
  loaded = true;
  keys.clear();
  lastCloud = null;
  setCloudAllowlist([]);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const key of keys.values()) {
    if (key.length >= 6) out = out.split(key).join("[key]");
  }
  return out.replace(/\b(sk-|xai-|sk-ant-)[A-Za-z0-9_\-]{8,}\b/g, "[key]");
}

export function setCloudPolicy(next: Policy) {
  policy = {
    allow: next.allow === true,
    roles: Object.fromEntries(
      ROLES.flatMap((role) => {
        const choice = next.roles?.[role];
        if (!choice || choice.mode === "off" || !choice.provider || !choice.model?.trim()) return [];
        if (!PROVIDERS[choice.provider]) return [];
        return [[role, { mode: choice.mode, provider: choice.provider, model: choice.model.trim() }]];
      }),
    ),
  };
  loaded = true;
  savePolicy();
  refreshAllowlist();
}

export async function saveCloudKey(provider: CloudProviderId, key: string) {
  const value = key.trim();
  if (value.length < 8) throw new Error("Enter the key from that provider.");
  await writeSecret(provider, value);
  keys.set(provider, value);
  refreshAllowlist();
}

export async function removeCloudKey(provider: CloudProviderId) {
  keys.delete(provider);
  await deleteSecret(provider);
  refreshAllowlist();
}

export function cloudPlan(role: Role): CloudMode | null {
  load();
  const choice = policy.roles[role];
  if (!policy.allow || !choice || choice.mode === "off" || !choice.provider || !choice.model) return null;
  if (!keys.has(choice.provider)) return null;
  return choice.mode;
}

export async function tryCloudChat(opts: { role: Role; messages: ChatMessage[]; tools?: ToolDef[]; fetchImpl?: typeof fetch }): Promise<ChatResult> {
  load();
  const choice = policy.roles[opts.role];
  if (!policy.allow || !choice?.provider || !choice.model || choice.mode === "off") throw new Error("Cloud models are off for this role.");
  const key = keys.get(choice.provider);
  if (!key) throw new Error("No key is saved for that provider.");
  refreshAllowlist();
  const host = PROVIDERS[choice.provider].host;
  if (!cloudAllowlistHas(host)) throw new Error("That provider's API is not on the allow list.");
  try {
    const result = await callProvider(choice.provider, choice.model, key, opts.messages, opts.tools ?? [], opts.fetchImpl ?? fetch);
    lastCloud = { provider: choice.provider, name: PROVIDERS[choice.provider].name, model: choice.model, role: opts.role, at: Date.now() };
    return { ...result, model: choice.model, endpoint: choice.provider, cloud: { provider: choice.provider, name: PROVIDERS[choice.provider].name } };
  } catch (e) {
    throw new Error(redactSecrets((e as Error).message || "The cloud model did not answer."));
  }
}

export function noteLocalAnswer() {
  lastCloud = null;
}

export async function listCloudModels(provider: CloudProviderId, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  load();
  const key = keys.get(provider);
  if (!policy.allow) throw new Error("Turn on Allow cloud models first.");
  if (!key) throw new Error("Save a key for that provider first.");
  refreshAllowlist();
  const host = PROVIDERS[provider].host;
  try {
    if (provider === "anthropic") {
      const res = await fetchImpl(`https://${host}/v1/models`, { headers: anthropicHeaders(key), signal: AbortSignal.timeout(20_000) });
      const body = await readJson(res, key);
      if (!res.ok) throw new Error(redactSecrets(typeof body.error === "string" ? body.error : `Model list answered ${res.status}`));
      const data = (body as { data?: { id?: string }[] }).data ?? [];
      return data.map((m) => m.id).filter((id): id is string => !!id);
    }
    const res = await fetchImpl(`https://${host}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    const body = await readJson(res, key);
    if (!res.ok) throw new Error(redactSecrets(`Model list answered ${res.status}`));
    const data = (body as { data?: { id?: string }[] }).data ?? [];
    return data.map((m) => m.id).filter((id): id is string => !!id);
  } catch (e) {
    throw new Error(redactSecrets((e as Error).message || "Could not list models."));
  }
}

export function publicCloudStatus() {
  load();
  return {
    allow: policy.allow,
    providers: cloudProviders(),
    roles: policy.roles,
    last: lastCloud,
  };
}

function cloudAllowlistHas(host: string) {
  refreshAllowlist();
  return setCloudHosts().includes(host);
}

function setCloudHosts(): string[] {
  if (!policy.allow) return [];
  return (Object.keys(PROVIDERS) as CloudProviderId[]).filter((id) => keys.has(id)).map((id) => PROVIDERS[id].host);
}

function refreshAllowlist() {
  setCloudAllowlist(setCloudHosts());
}

async function callProvider(provider: CloudProviderId, model: string, key: string, messages: ChatMessage[], tools: ToolDef[], fetchImpl: typeof fetch): Promise<Omit<ChatResult, "model" | "endpoint">> {
  const host = PROVIDERS[provider].host;
  if (provider === "anthropic") return anthropic(host, model, key, messages, tools, fetchImpl);
  return openaiCompatible(host, model, key, messages, tools, fetchImpl);
}

async function openaiCompatible(host: string, model: string, key: string, messages: ChatMessage[], tools: ToolDef[], fetchImpl: typeof fetch) {
  const res = await fetchImpl(`https://${host}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}), temperature: 0.2 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await readJson(res, key);
  if (!res.ok) throw new Error(redactSecrets(`The provider answered ${res.status}.`));
  const message = (body as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[] }).choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (message?.tool_calls ?? []).flatMap((c) => {
    const name = String(c.function?.name || "");
    if (!name) return [];
    const args = c.function?.arguments;
    return [{ id: c.id || name, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }];
  });
  return { content, toolCalls };
}

async function anthropic(host: string, model: string, key: string, messages: ChatMessage[], tools: ToolDef[], fetchImpl: typeof fetch) {
  let system = "";
  const chat: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    const text = textOf(message);
    if (message.role === "system") system += `${text}\n`;
    else if (message.role === "user" || message.role === "assistant") chat.push({ role: message.role, content: text });
  }
  const res = await fetchImpl(`https://${host}/v1/messages`, {
    method: "POST",
    headers: { ...anthropicHeaders(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      ...(system.trim() ? { system: system.trim() } : {}),
      messages: chat.length ? chat : [{ role: "user", content: "" }],
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: "object" } })) } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await readJson(res, key)) as { content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[] };
  if (!res.ok) throw new Error(redactSecrets(`The provider answered ${res.status}.`));
  const blocks = body.content ?? [];
  return {
    content: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
    toolCalls: blocks.flatMap((b) => (b.type === "tool_use" && b.name ? [{ id: b.id || b.name, name: b.name, arguments: JSON.stringify(b.input ?? {}) }] : [])),
  };
}

function anthropicHeaders(key: string) {
  return { "x-api-key": key, "anthropic-version": "2023-06-01" };
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

async function readJson(res: Response, key: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(redactSecrets(text)) as Record<string, unknown>;
  } catch {
    throw new Error(redactSecrets(text.slice(0, 180) || `The provider answered ${res.status}.`).split(key).join("[key]"));
  }
}

function home() {
  return process.env.BOPS_CLOUD_HOME?.trim() || process.env.BOPS_DATA_DIR?.trim() || join(process.cwd(), ".data");
}

function policyPath() {
  return join(home(), "cloud-models.json");
}

function keyPath() {
  return join(home(), "cloud-keys.json");
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(policyPath(), "utf8")) as Policy;
    policy = { allow: parsed.allow === true, roles: parsed.roles ?? {} };
  } catch {
    policy = { allow: false, roles: {} };
  }
  if (process.env.BOPS_CLOUD_KEY_STORE === "file" || process.platform !== "darwin") {
    try {
      const parsed = JSON.parse(readFileSync(keyPath(), "utf8")) as Partial<Record<CloudProviderId, string>>;
      for (const id of Object.keys(PROVIDERS) as CloudProviderId[]) if (parsed[id]) keys.set(id, parsed[id] as string);
    } catch {
      /* no file yet */
    }
  }
  refreshAllowlist();
}

function savePolicy() {
  const dir = home();
  mkdirSync(dir, { recursive: true });
  writeFileSync(policyPath(), JSON.stringify(policy), { mode: 0o600 });
  try {
    chmodSync(policyPath(), 0o600);
  } catch {
    /* windows */
  }
}

async function writeSecret(provider: CloudProviderId, value: string) {
  if (process.env.BOPS_CLOUD_KEY_STORE !== "file") {
    try {
      if (process.platform === "darwin") return await macSecret("set", provider, value);
      if (process.platform === "win32") return await windowsSecret("set", provider, value);
    } catch {
      /* keychain unavailable: the 0600 file is the fallback */
    }
  }
  fileSecret("set", provider, value);
}

async function deleteSecret(provider: CloudProviderId) {
  if (process.env.BOPS_CLOUD_KEY_STORE !== "file") {
    try {
      if (process.platform === "darwin") await macSecret("del", provider);
      if (process.platform === "win32") await windowsSecret("del", provider);
    } catch {
      /* still remove the file copy */
    }
  }
  fileSecret("del", provider);
}

function fileSecret(op: "set" | "del", provider: CloudProviderId, value = "") {
  const dir = home();
  mkdirSync(dir, { recursive: true });
  const path = keyPath();
  let parsed: Partial<Record<CloudProviderId, string>> = {};
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<CloudProviderId, string>>;
  } catch {
    parsed = {};
  }
  if (op === "del") delete parsed[provider];
  else parsed[provider] = value;
  writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

function macSecret(op: "set" | "del", provider: CloudProviderId, value = "") {
  const account = `bops-cloud-${provider}`;
  if (op === "del") return exec(["security", "delete-generic-password", "-s", "Bops Vault", "-a", account]);
  return new Promise<void>((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("The keychain did not save the key."))));
    child.stdin.end(`add-generic-password -U -s "Bops Vault" -a "${account}" -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
    void err;
  });
}

function windowsSecret(op: "set" | "del", provider: CloudProviderId, value = "") {
  const dir = join(process.env.APPDATA || homedir(), "Bops");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `cloud-${provider}.dpapi`);
  if (op === "del") {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  }
  const script = `
$in = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($in)
$prot = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllBytes(${JSON.stringify(path)}, $prot)
`;
  return new Promise<void>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Windows did not store the key."))));
    child.stdin.end(value);
    void err;
  });
}

function exec(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: "ignore" });
    child.on("error", () => reject(new Error("The keychain is not available.")));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("The keychain did not change the key."))));
  });
}

export function cloudKeyFile() {
  return keyPath();
}
