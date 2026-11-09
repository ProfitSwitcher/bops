# Local setup

This fork runs Bops on your own machines. After the software and the models are downloaded, chat, tool calling, computer use, and memory keep working with internet egress blocked. `BOPS_LOCAL_ONLY` defaults to on. The app does not fall back to OpenAI, Orgo, Honcho, or any other hosted API. It also does not ask for an Orgo, Google, or email sign-in. You are the local owner. A password in front of the server is what keeps the home network out.

Model names and which machine serves them are configuration. The file `bops.local.example.json` is the default plan below. Copy it to `bops.local.json` and change hosts, tokens, and tags without touching code. A `:cloud` Ollama tag is dropped wherever it appears. `glm-5.3-flash` is one of those: Ollama only offers it as a cloud model.

## Machines

| Machine | Role | Notes |
|---|---|---|
| Studio 3 | App host, primary Ollama, and one node of the exo cluster | Mac Studio, M3 Ultra, 32 CPU / 80 GPU, 512 GB unified memory. Ollama on loopback. exo's API is `http://127.0.0.1:52415/v1` on this machine too. No Docker: the computer worker is native macOS. |
| Studio 1 | exo master, second Ollama machine, same hardware | Joins Studio 3 over Thunderbolt RDMA. Planner fallback is the MLX model, served however you run MLX (the example uses an authenticated proxy on port 8081). |
| Geforce5 | Fast and vision when the Studios' copies are missing, and a Windows worker | RTX 5090 Laptop, 24 GB VRAM. The 122B and 27B-q8 models do not fit. Its vision tag is `qwen3.8:latest` at q4_K_M, and its fast tag is `qwen3:4b`. Ollama or llama.cpp with CUDA. |
| PC4 | Optional worker only | Windows 11, i7-6770HQ, 32 GB, no CUDA, virtualization reported off. Not an inference target. Address on the LAN is 192.168.1.128; put that in `bops.local.json` only if you add the worker. |

Ollama is not the same version on every machine (0.30.9, 0.32.14, and 0.34.4). The client tries `/v1/chat/completions`, then native `/api/chat`, and for embeddings `/v1/embeddings`, then `/api/embed`, then `/api/embeddings`. A tag that is not installed is skipped. The next entry in that role's chain is tried. A machine that does not answer is skipped. Nothing is sent to a public host.

## Model plan

Edit `bops.local.json`. Empty `apiKey` is allowed only for loopback. Every other endpoint must set one. The example sends LAN traffic through `workers/bops-llm-proxy.mjs`, which checks the bearer token and forwards only to `127.0.0.1`.

| Role | First choice | Then |
|---|---|---|
| Planner | `ornith-1.5:122b` on Studio 3 | `qwen3.8-flash-next:125b-mlx` on Studio 1, then `qwen3.5:122b` |
| Heavy (hard planning and coding) | exo on the Studio cluster, first `mlx-community/Kimi-K2.7-Code-4bit` | the other downloaded exo ids in `bops.local.example.json`, then the Ollama planner |
| Vision / computer use | `qwen3.8:27b-q8_0` on Studio 3 | the same tag on Studio 1, then `qwen3.8:latest` (q4_K_M) on Geforce5, then `qwen3.5:122b` |
| Fast / router | `nemotron-3.5-lightning:30b` on Studio 3 | the same tag on Studio 1, then `qwen3:30b`, then `qwen3:4b` on Geforce5 |
| Embeddings | `qwen3-embedding:8b` on Studio 3 | the same tag on Studio 1, then Geforce5 |

Hard tasks (high effort) use the heavy role. A model still downloading, including GLM-5.3-Flash until exo's `/state` marks it `DownloadCompleted`, is skipped. The `/v1/models` catalog lists models that are not on disk and is not used as the allow list. Chat is sent only for a model `/state` reports as fully downloaded, so a request does not start a Hugging Face download. Loading an already-downloaded model into memory can take several minutes. Settings shows "Warming up" while that request is in flight. The wait is `BOPS_EXO_LOAD_TIMEOUT_MS` (default 10 minutes). If exo is down, or none of its configured models are fully downloaded, the heavy role continues to the Ollama planner.

### exo

Run exo on Studio 1 and Studio 3 with Hugging Face offline. Set this in the environment of the exo process on both machines, before exo starts:

```bash
export HF_HUB_OFFLINE=1
```

The cluster is one exo over Thunderbolt RDMA. Either studio's API on port 52415 sees the same models. The example points the app at `http://127.0.0.1:52415/v1` because Studio 3 runs the app. Change `exo.baseUrl` if the app runs somewhere else, and put the token-checking proxy in front if that address is not loopback.

A model is eligible when at least one node has finished downloading it and no node is still downloading it or has failed. exo can place that copy on the machine that holds the weights, so Kimi and Qwen3-Coder count when they are complete on Studio 1 only. The ids in the example are the ones `/state` reports: `mlx-community/Kimi-K2.7-Code-4bit`, `mlx-community/Qwen3-Coder-480B-A35B-Instruct-8bit`, `mlx-community/GLM-5.2-mxfp4`, and `MiniMaxAI/MiniMax-M2.7`. Add others from `/state` the same way. `BOPS_LLM_HEAVY_MODEL` prepends one id without editing the file.

Chat on exo needs a running instance. If `/state` has none for the chosen model, the app reads `GET /instance/previews` and `POST`s `/place_instance` only for a preview whose nodes already have that model `DownloadCompleted`. Tensor across both Studios is used when both already have it. A copy that exists only on Studio 1 is placed with pipeline on that node, even if the other node still has a leftover `DownloadPending`. A placement that would include a node without the weights is not sent, so exo is not asked to download. It then polls `/state` until that instance's runners are `RunnerReady`, within `BOPS_EXO_LOAD_TIMEOUT_MS`. A runner in `RunnerFailed` stops the wait immediately. If the instance this attempt created fails or never becomes ready, that instance is deleted. exo 0.3.70 then cancels every in-progress download a running model is not using, so the app snapshots those from `/state` and `POST`s `/download/start` with the same shard for each one, then checks they are in progress again. An instance that was already running is left in place. After two such failures in a row, exo is skipped for 30 minutes (`BOPS_EXO_FAIL_LIMIT`, `BOPS_EXO_COOLDOWN_MS`) and heavy continues with the next model. An instance that is already running for that model is reused. A different large instance is not stopped when the new one will not fit. Set `"exo": {"allowEvict": true}` or `BOPS_EXO_ALLOW_EVICT=1` to allow that. Otherwise heavy continues to the next model, then the Ollama planner.

Environment variables prepend one step without editing the file: `BOPS_LLM_PLANNER_MODEL`, `BOPS_LLM_FAST_MODEL`, `BOPS_LLM_VISION_MODEL`, `BOPS_LLM_EMBED_MODEL`, and `BOPS_LLM_<ROLE>_ENDPOINT`. A value containing `:cloud` is ignored.

To point a role at llama.cpp, LM Studio, MLX, or vLLM, set that endpoint's `provider` and `baseUrl`. They all speak `/v1/chat/completions`. Health checks accept Ollama's `/api/tags` and `/v1/models`.

```bash
# On each machine, only the tags that machine is supposed to hold.
ollama pull ornith-1.5:122b
ollama pull qwen3.5:122b
ollama pull qwen3.8:27b-q8_0
ollama pull nemotron-3.5-lightning:30b
ollama pull qwen3:30b
ollama pull qwen3-embedding:8b
# Geforce5 (24 GB):
ollama pull qwen3.8:latest
ollama pull qwen3:4b
```

`ollama list` must not be how a cloud model gets into the chain. If `glm-5.3-flash:cloud` or `minimax-m2.7:cloud` is installed, leave it there; the app will not select it.

## Install

Node 22 or newer. On the Mac that runs the app (Studio 3):

```bash
npm install
cp bops.local.example.json bops.local.json
# edit tokens and hostnames
node workers/bops-local-worker.mjs
npx next build
npm run local:server
```

`next dev` is for editing the app. `next start` does not run a build made with `output: "standalone"` (the desktop app needs that output). `npm run local:server` copies the static files into `.next/standalone` and runs `node server.js` from that folder on `127.0.0.1:3210`. It sets `BOPS_DATA_DIR` and `BOPS_LOCAL_CONFIG` to this checkout, so state and tokens stay in the repo's `.data` and `bops.local.json`. A rebuild does not replace them. Fonts are files in `app/fonts`, so the server does not fetch them.

The desktop app is still `npm run app` on Apple silicon. The server comes up with the egress guard installed.

### Start at login

These files do not install themselves.

macOS: copy `scripts/macos/ai.bops.local.plist`, replace `REPLACE_WITH_REPO` with this checkout, and `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.bops.local.plist`. It runs `scripts/local-login.sh`, which starts the worker and the server on `127.0.0.1`.

Windows: `powershell -File scripts/windows/register-bops-login.ps1` registers a task named "Bops local" that runs at logon, also on `127.0.0.1`. `-Remove` deletes it. Build with `npx next build` first.

### Studio 1 and Geforce5 inference

On each machine, Ollama listens on `127.0.0.1:11434` only. The proxy is what the LAN can see:

```bash
# Studio 1, in front of Ollama
BOPS_LLM_PROXY_BIND=<that Mac's LAN address> BOPS_LLM_PROXY_PORT=11435 \
  BOPS_LLM_PROXY_TOKEN=<token> BOPS_LLM_UPSTREAM=http://127.0.0.1:11434 \
  node workers/bops-llm-proxy.mjs
```

Use a second proxy port for the MLX server if `qwen3.8-flash-next:125b-mlx` is not served by Ollama. Point `studio1-mlx.baseUrl` at it. MLX's own server is `mlx_lm.server` (or the equivalent you already use) bound to loopback.

Geforce5 can run llama.cpp's `llama-server` instead of Ollama. Set that endpoint's `provider` to `llamacpp` and its `baseUrl` to the proxy in front of it.

Do not bind the proxy or the worker to `0.0.0.0`. The process refuses that. Do not port-forward them.

### Workers

```bash
# Mac (Studio 3 or Studio 1). Accessibility permission is required for clicks.
BOPS_WORKER_BIND=127.0.0.1 BOPS_WORKER_PORT=8791 node workers/bops-local-worker.mjs

# A LAN listener, one address, with a token
BOPS_WORKER_BIND=<lan-ip> BOPS_WORKER_TOKEN=<token> node workers/bops-local-worker.mjs
```

The worker uses `screencapture` and System Events on macOS, PowerShell on Windows, and `xdotool` plus `import` or `gnome-screenshot` on Linux. There is no Docker step. A Mac without Docker does not need a VM.

If you later want an isolated Linux desktop, UTM or Tart can run one from an image you already have. That is optional. PC4 cannot host it: virtualization is off there. Give PC4 the Windows worker instead, and only if you add it to `workers` in the config.

Human approval for risky tool calls is unchanged. The worker runs an action only after the app has already sent it.

## Optional cloud models

Local models stay the default. Grok, ChatGPT, and Claude are usable only after you turn on **Allow cloud models** in Settings and save a key for that provider. A role still stays on the local chain unless you set that role to **Cloud first** or **Cloud if local fails**. There is no silent fallback.

The key is stored in the macOS Keychain or Windows DPAPI (CurrentUser). If neither is available, it is written to a file mode `0600` under the app data directory. It is not written to logs. It is sent only to that provider's own API: `api.x.ai`, `api.openai.com`, or `api.anthropic.com`. While the switch is on and a key is saved, the egress guard allows that host and no other public host. Turn the switch off, or remove the key, and the host is refused again.

Model ids come from each provider's models endpoint (Test in Settings) or from the model field you type. The chat shows a **Cloud model** badge when the latest answer came from one of these providers.

## Chat on this machine

A short message (a greeting, a one-word reply) is answered with one planner call and a short prompt. Routing, memory search, and fact labeling are skipped for that turn. Longer messages still use the planner, with the last few turns of the chat. Set `BOPS_CHAT_TIMING=1` to log each stage in milliseconds (`[chat] route`, `[chat] memory`, `[chat] simple-model`).

## What is offline

Settings shows the same list.

| Still works | Unavailable, and the UI says so |
|---|---|
| Chat, tool calling, the fast router | Bot email (AgentMail) |
| Computer use through a local worker | Phone, texts, calls (AgentPhone) |
| Memory in SQLite, embeddings if the embed model is up, otherwise word overlap | Connected apps (Composio) |
| Small judgments on the fast model, or the old rules if that model is down | Slack, Telegram, Discord |
| | Business data (treg) |
| | Web search and public page fetches |
| | Cloud image generation and cloud transcription |
| | Publishing apps, domains, Orgo deploys |
| | PostHog and other telemetry |

Voice transcription stays off until `BOPS_LLM_TRANSCRIBE_MODEL` names a local speech model. Codex-on-this-Mac is refused because the Codex CLI calls OpenAI. Use a local worker on that Mac instead.

## Cloud dependencies

Runtime means a request while the app is in use. Build means `npm install` or `next build`. The egress guard blocks the runtime column.

| Dependency | When | What it did | In this fork |
|---|---|---|---|
| OpenAI Responses, Chat, Agents | Runtime | Chat, tools, computer use, Codex | Local chain. Cloud model names are rewritten onto the role. |
| OpenAI images, realtime, SIP | Runtime | Pictures, live voice | Refused. |
| OpenAI audio transcription | Runtime | Mic | Local model only if configured, otherwise refused. |
| Codex CLI | Runtime | Tasks on the Mac | Refused. |
| Orgo API, relay, ingot | Runtime and release build | Cloud computers, Chrome relay | Local workers. Release binaries are unused. |
| Bops Cloud | Runtime | Keys, state, webhooks | Off. State stays in `.data/`. |
| Honcho | Runtime | Memory | SQLite plus local embeddings. |
| Composio | Runtime | Connectors, and its own telemetry host | Off. |
| treg | Runtime | Company and people data | Off. |
| AgentMail | Runtime | Bot email | Off. |
| AgentPhone | Runtime | Numbers, texts, calls | Off. |
| Twilio Verify | Runtime | Ownership codes | Off with phone and email. |
| TypeSafe | Runtime | Yes/no judgments | Fast local model, or the existing rules if it is down. |
| PostHog (`posthog-js`, `posthog-node`, the marketing snippet) | Runtime | Usage events | Not loaded. |
| Telegram, Discord, Slack APIs | Runtime | Team chat | Listeners are not started. |
| Geist fonts | Bundled in `app/fonts` | UI fonts | `next/font/local`. No Google Fonts request in dev or prod. |
| Google Fonts on `site/` | Marketing site only | The public download page | Not the app. |
| npm registry | Install | Packages | Needed once, not while the app runs. |
| electron-builder GitHub publish | Release | Update feed for OrgoAI/bops | Not used by `next dev`. Do not publish this fork upstream. |

## Check that it is offline

1. `npm run test:local` — provider, failover, `:cloud` rejection, memory, worker, proxy, and a tripwire that fails the test if anything connects to a public address.
2. Start the app. Open Settings. The notice lists the model that answered for each role, and the features that are off.
3. Block egress (Little Snitch, Windows Firewall outbound default-deny, or `pf` on the Mac). Leave LAN and loopback allowed, including your router or Tailscale for DNS (`100.100.100.100` is allowed; `1.1.1.1` and `8.8.8.8` are not).
4. Send a chat, save a memory, and run a computer-use turn against the local worker. They should finish. Email, phone, connected apps, and web search should say they are unavailable.

`GET /api/local` is the same information as the Settings notice.

## Rollback

Set `BOPS_LOCAL_ONLY=0` in `.env.local` and restart. The process leaves the guard off and the upstream provider code runs again, which needs the OpenAI and Orgo keys from the original README. To drop the fork's edits, check out the previous commit. Do not push this branch to `OrgoAI/bops`.
