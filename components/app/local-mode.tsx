"use client";

import { useEffect, useState } from "react";

type Feature = { id: string; name: string; available: boolean; reason: string };
type Ready = { endpoint: string; model: string; quant?: string };
type RoleInfo = { chain: { endpoint: string; model: string; quant?: string }[]; ready: Ready[]; skipped: string[] };
type Info = {
  localOnly: boolean;
  features: Feature[];
  roles: Record<string, RoleInfo>;
  endpoints?: { id: string; baseUrl: string; provider: string }[];
  workers?: { id: string; url: string; kind?: string }[];
  exo?: { warming: { endpoint: string; model: string; forMs: number } | null };
};

const LABELS: Record<string, string> = { planner: "Planner", fast: "Fast", vision: "Vision", embed: "Embeddings", heavy: "Heavy" };

/** Settings notice: which local models answered, and which hosted features are off. */
export function LocalModeNotice() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      void fetch("/api/local")
        .then((r) => r.json())
        .then((body: Info) => {
          if (!stop) setInfo(body);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!info?.localOnly) return null;
  const off = info.features.filter((f) => !f.available);
  return (
    <div className="mx-[22px] mt-4 flex flex-col gap-2 rounded-[14px] bg-[#F7F7F5] p-3.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
      <span className="text-[13px] font-semibold text-ink">Running on your machines</span>
      <span>Chat, tools, computer use, and memory stay on this network. A model that is not installed is skipped for the next one in bops.local.json. Cloud tags (anything ending in :cloud, including glm-5.3-flash) are refused.</span>
      {info.exo?.warming && (
        <span className="font-medium text-ink">
          Warming up {info.exo.warming.model} on {info.exo.warming.endpoint}. A large exo model can take a few minutes to load. This does not download weights.
        </span>
      )}
      <div className="flex flex-col gap-1">
        {Object.entries(info.roles).map(([role, spec]) => (
          <span key={role}>
            <span className="text-[#9A9A98]">{LABELS[role] ?? role}: </span>
            {spec.ready[0] ? `${spec.ready[0].model} on ${spec.ready[0].endpoint}${spec.ready[0].quant ? ` (${spec.ready[0].quant})` : ""}` : "none of the configured models answered"}
          </span>
        ))}
      </div>
      <span className="pt-1 font-medium text-ink">Unavailable offline</span>
      <ul className="flex flex-col gap-1">
        {off.map((f) => (
          <li key={f.id}>
            <span className="font-medium">{f.name}. </span>
            {f.reason}
          </li>
        ))}
      </ul>
      <CloudModels />
    </div>
  );
}

type CloudProvider = { id: "xai" | "openai" | "anthropic"; name: string; host: string; hasKey: boolean };
type CloudStatus = {
  allow: boolean;
  providers: CloudProvider[];
  roles: Record<string, { mode: "prefer" | "fallback"; provider: CloudProvider["id"]; model: string }>;
  last: { name: string; model: string; provider: string } | null;
};

const ROLE_NAMES = ["heavy", "planner", "fast", "vision", "embed"] as const;

type RoleDraft = { mode: string; provider: string; model: string };

/**
 * Whether this server is local-only. Starts on, so a slow config read cannot flash an Orgo
 * account page, and flips off only when the server says local-only is off.
 */
export function useLocalOnly() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let stop = false;
    void fetch("/api/config")
      .then((r) => r.json())
      .then((body: { localOnly?: boolean }) => {
        if (!stop) setOn(body.localOnly !== false);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  return on;
}

/** Settings, Plan: the machines and models in use. No subscription and no link off this Mac. */
export function LocalMachines() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    let stop = false;
    void fetch("/api/local")
      .then((r) => r.json())
      .then((body: Info) => {
        if (!stop) setInfo(body);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  const endpoints = info?.endpoints ?? [];
  const workers = info?.workers ?? [];
  return (
    <div className="flex flex-col gap-4 px-[22px] pt-[18px]">
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold">Machines</span>
        <div className="flex flex-col rounded-[14px] px-3.5 shadow-[0_0_0_1px_#E6E6E3]">
          {endpoints.map((e) => (
            <span key={e.id} className="border-b border-[#F0F0EE] py-2 text-[13px] last:border-0">
              <span className="font-medium">{e.id}</span> <span className="text-[#6B6B6B]">{e.provider} · {e.baseUrl}</span>
            </span>
          ))}
          {workers.map((w) => (
            <span key={w.id} className="border-b border-[#F0F0EE] py-2 text-[13px] last:border-0">
              <span className="font-medium">{w.id}</span> <span className="text-[#6B6B6B]">worker · {w.kind ?? "native"} · {w.url}</span>
            </span>
          ))}
          {!info && <span className="py-2 text-[13px] text-[#6B6B6B]">Reading this Mac&apos;s config…</span>}
          {info && !endpoints.length && !workers.length && <span className="py-2 text-[13px] text-[#6B6B6B]">No machines in bops.local.json.</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold">Models in use</span>
        <div className="flex flex-col rounded-[14px] px-3.5 shadow-[0_0_0_1px_#E6E6E3]">
          {Object.entries(info?.roles ?? {}).map(([role, spec]) => (
            <span key={role} className="border-b border-[#F0F0EE] py-2 text-[13px] last:border-0">
              <span className="text-[#9A9A98]">{LABELS[role] ?? role}: </span>
              {spec.ready[0] ? `${spec.ready[0].model} on ${spec.ready[0].endpoint}` : "none of the configured models answered"}
            </span>
          ))}
          {!info && <span className="py-2 text-[13px] text-[#6B6B6B]">Checking which models answered…</span>}
        </div>
      </div>
    </div>
  );
}

/** Optional keys. They stay on this machine and are sent only to that provider. */
function CloudModels() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [roleDraft, setRoleDraft] = useState<Record<string, RoleDraft>>({});
  const [note, setNote] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const load = () =>
    void fetch("/api/local/cloud")
      .then((r) => r.json())
      .then((body: CloudStatus) => setStatus(body))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const send = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as CloudStatus & { error?: string; models?: string[] };
    if (!res.ok) {
      setNote(json.error || "That did not work.");
      return json;
    }
    if (json.providers) setStatus(json);
    setNote(null);
    return json;
  };
  if (!status) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-[#E6E6E3] pt-2">
      <span className="text-[13px] font-semibold text-ink">Cloud models (optional)</span>
      <span>Off unless you turn this on and save a key. A role uses a cloud model only if you pick it for that role, or as a last resort after the local chain. Keys stay on this machine.</span>
      <label className="flex items-center gap-2 font-medium text-ink">
        <input type="checkbox" checked={status.allow} onChange={(e) => void send({ op: "allow", allow: e.target.checked })} />
        Allow cloud models
      </label>
      {status.providers.map((provider) => (
        <div key={provider.id} className="flex flex-col gap-1">
          <span className="font-medium text-ink">
            {provider.name} <span className="font-normal text-[#9A9A98]">{provider.host}</span>
            {provider.hasKey ? " · key saved" : " · no key"}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <input
              type="password"
              autoComplete="off"
              value={drafts[provider.id] ?? ""}
              placeholder="Paste a key, then save"
              onChange={(e) => setDrafts((d) => ({ ...d, [provider.id]: e.target.value }))}
              className="h-7 w-[220px] rounded-full bg-white px-2 text-[12px] outline-none shadow-[0_0_0_1px_#E6E6E3]"
            />
            <button
              type="button"
              className="rounded-full bg-ink px-2 py-1 text-[12px] text-white"
              onClick={() => {
                const key = drafts[provider.id] ?? "";
                setDrafts((d) => ({ ...d, [provider.id]: "" }));
                void send({ op: "key", provider: provider.id, key });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="rounded-full bg-white px-2 py-1 text-[12px] shadow-[0_0_0_1px_#E6E6E3]"
              onClick={() =>
                void send({ op: "test", provider: provider.id }).then((json) => {
                  if (json.models) setModels((m) => ({ ...m, [provider.id]: json.models as string[] }));
                  if (json.models) setNote(`${provider.name}: ${json.models.length} models.`);
                })
              }
            >
              Test
            </button>
            <button type="button" className="rounded-full bg-white px-2 py-1 text-[12px] shadow-[0_0_0_1px_#E6E6E3]" onClick={() => void send({ op: "remove", provider: provider.id })}>
              Remove
            </button>
          </span>
        </div>
      ))}
      {ROLE_NAMES.map((role) => {
        const saved = status.roles?.[role];
        const draft = roleDraft[role] ?? { mode: saved?.mode ?? "off", provider: saved?.provider ?? "", model: saved?.model ?? "" };
        const setDraft = (patch: Partial<RoleDraft>) => {
          const next = { ...draft, ...patch };
          setRoleDraft((d) => ({ ...d, [role]: next }));
          if (next.mode === "off") void send({ op: "role", role, mode: "off" });
          else if (next.provider && next.model.trim()) void send({ op: "role", role, mode: next.mode, provider: next.provider, model: next.model.trim() });
          else setNote("Pick a provider and a model.");
        };
        return (
          <span key={role} className="flex flex-wrap items-center gap-1">
            <span className="w-16 text-[#9A9A98]">{LABELS[role]}</span>
            <select value={draft.mode} onChange={(e) => setDraft({ mode: e.target.value })} className="h-7 rounded-full bg-white px-2 text-[12px]">
              <option value="off">Local only</option>
              <option value="prefer">Cloud first</option>
              <option value="fallback">Cloud if local fails</option>
            </select>
            <select value={draft.provider} onChange={(e) => setDraft({ provider: e.target.value })} className="h-7 rounded-full bg-white px-2 text-[12px]">
              <option value="">Provider</option>
              {status.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              value={draft.model}
              placeholder="model id"
              list={`models-${role}`}
              onChange={(e) => setRoleDraft((d) => ({ ...d, [role]: { ...draft, model: e.target.value } }))}
              onBlur={(e) => setDraft({ model: e.target.value })}
              className="h-7 w-[180px] rounded-full bg-white px-2 text-[12px] outline-none shadow-[0_0_0_1px_#E6E6E3]"
            />
            <datalist id={`models-${role}`}>
              {(draft.provider ? models[draft.provider] ?? [] : []).map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </span>
        );
      })}
      {note && <span>{note}</span>}
    </div>
  );
}

/** Shown above the chat when the latest answer came from a cloud model the owner enabled. */
export function CloudAnswerBadge() {
  const [last, setLast] = useState<{ name: string; model: string } | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      void fetch("/api/local/cloud")
        .then((r) => r.json())
        .then((body: CloudStatus) => {
          if (!stop) setLast(body.last ?? null);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!last) return null;
  return (
    <div className="mx-4 mt-2 w-fit rounded-full bg-[#1F1A14] px-2.5 py-1 text-[12px] font-medium text-[#F4E7C3]">
      Cloud model: {last.name} · {last.model}
    </div>
  );
}
