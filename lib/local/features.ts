/** What still works offline, and what this fork refuses to call. */
import { allowEgress } from "./mode";

export type LocalFeature = {
  id: string;
  name: string;
  available: boolean;
  reason: string;
};

export function offlineFeatures(): LocalFeature[] {
  const speech = !!(process.env.BOPS_LLM_TRANSCRIBE_URL?.trim() || process.env.BOPS_LLM_TRANSCRIBE_MODEL?.trim() || (process.env.BOPS_WHISPER_BIN?.trim() && process.env.BOPS_WHISPER_MODEL?.trim()));
  const net = allowEgress();
  const mailKey = !!process.env.AGENTMAIL_API_KEY?.trim();
  return [
    { id: "chat", name: "Chat", available: true, reason: "Chat goes to the local model chain in bops.local.json." },
    { id: "tools", name: "Tool calling", available: true, reason: "Tools are sent to the local model. A model that can't call tools is asked to print JSON instead." },
    { id: "computer", name: "Computer use", available: true, reason: "Screenshots go to the vision model. Clicks run on a local worker, not an Orgo computer." },
    { id: "memory", name: "Memory", available: true, reason: "Memory is a SQLite file on this machine. Embeddings use qwen3-embedding:8b, or the next embed model in the chain. Word overlap is used if embeddings are down." },
    { id: "telemetry", name: "Telemetry", available: false, reason: "PostHog and the rest of the usage telemetry are off. Nothing is sent." },
    { id: "email", name: "Bot email", available: net && mailKey, reason: !net ? "AgentMail is an internet service. Email is unavailable offline." : mailKey ? "Bot email can reach the network." : "Internet is allowed, but no mail account is connected yet." },
    { id: "phone", name: "Phone, texts, and calls", available: false, reason: "AgentPhone is an internet service. Phone is unavailable offline." },
    { id: "apps", name: "Connected apps", available: false, reason: "Composio hosts Gmail, Slack, and the other connectors. They are unavailable offline." },
    { id: "channels", name: "Slack, Telegram, and Discord", available: false, reason: "Those chats need the public internet. They are unavailable offline." },
    { id: "data", name: "Business data", available: false, reason: "treg is an internet data service. Lookups are unavailable offline." },
    { id: "web", name: "Web search", available: net, reason: net ? "Public web search and page fetches go out from this machine." : "Public web search and page fetches are unavailable offline. The bot is told that, instead of calling a search API." },
    { id: "images", name: "Image generation", available: false, reason: "Cloud image models are not called. Drawing pictures is unavailable offline." },
    { id: "speech", name: "Voice transcription", available: speech, reason: speech ? "Transcription uses a local whisper server (BOPS_LLM_TRANSCRIBE_URL) or whisper.cpp (BOPS_WHISPER_BIN and BOPS_WHISPER_MODEL)." : "Voice transcription is off until BOPS_LLM_TRANSCRIBE_URL or BOPS_WHISPER_BIN and BOPS_WHISPER_MODEL is set. Audio is not sent to a cloud." },
    { id: "hosting", name: "Publishing apps on the web", available: false, reason: "Public hosting, domains, and Orgo deploys are unavailable offline." },
  ];
}
