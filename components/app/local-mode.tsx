"use client";

import { useEffect, useState } from "react";

type Feature = { id: string; name: string; available: boolean; reason: string };
type Ready = { endpoint: string; model: string; quant?: string };
type RoleInfo = { chain: { endpoint: string; model: string; quant?: string }[]; ready: Ready[]; skipped: string[] };
type Info = { localOnly: boolean; features: Feature[]; roles: Record<string, RoleInfo> };

const LABELS: Record<string, string> = { planner: "Planner", fast: "Fast", vision: "Vision", embed: "Embeddings" };

/** Settings notice: which local models answered, and which hosted features are off. */
export function LocalModeNotice() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void fetch("/api/local")
      .then((r) => r.json())
      .then((body: Info) => setInfo(body))
      .catch(() => setInfo(null));
  }, []);
  if (!info?.localOnly) return null;
  const off = info.features.filter((f) => !f.available);
  return (
    <div className="mx-[22px] mt-4 flex flex-col gap-2 rounded-[14px] bg-[#F7F7F5] p-3.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
      <span className="text-[13px] font-semibold text-ink">Running on your machines</span>
      <span>Chat, tools, computer use, and memory stay on this network. A model that is not installed is skipped for the next one in bops.local.json. Cloud tags (anything ending in :cloud, including glm-5.3-flash) are refused.</span>
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
    </div>
  );
}
