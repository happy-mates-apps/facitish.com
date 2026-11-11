// /admin/messages/delivery → Levering. One row per recipient and channel: what arrived, what waits for quiet hours to
// end, and what the provider refused. Phone numbers and e-mail addresses are masked; SMS rows go after 90 days.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity } from "lucide-react";
import { api, query } from "../../../api";
import { card, input, select, tableHead } from "../../theme";
import { Empty, ErrorBox, PageTitle, Pager, useLoad } from "../../ui";
import { CHANNEL, grid, kr, muted, Stat, StatusPill, when } from "./shared";

type Row = {
  id: number; broadcast_id: number; user_id: number; channel: string; status: string; reason: string; error: string | null;
  held_until: string | null; cost_minor: number; created_at: string; sent_at: string | null; delivered_at: string | null;
  read_at: string | null; title: string; segments: number | null; display_name: string; to: string | null;
};
type Data = { items: Row[]; total: number; summary: { ok: number; held: number; failed: number; all_rows: number; sms_segments: number } };

const TABS: [string, string][] = [["", "Alle"], ["sms", "SMS"], ["mail", "E-mail"], ["app", "I appen"]];
const LIMIT = 100;
const COLS = "130px minmax(0,1.4fr) minmax(0,1fr) 80px 110px minmax(0,1.6fr)";

function detail(r: Row): string {
  if (r.error) return r.error;
  const parts = [r.to].filter(Boolean) as string[];
  if (r.segments) parts.push(`${r.segments} segment${r.segments === 1 ? "" : "er"}${r.cost_minor ? ` · ca. ${kr(r.cost_minor)}` : ""}`);
  if (r.status === "held" && r.held_until) parts.push(`sendes ${when(r.held_until)}`);
  if (r.read_at) parts.push(`læst ${when(r.read_at)}`);
  if (r.reason === "reply") parts.push("svar fra jer");
  return parts.join(" · ") || "—";
}

export default function Delivery() {
  const [params, setParams] = useSearchParams();
  const channel = params.get("channel") ?? "";
  const status = params.get("status") ?? "";
  const broadcast = params.get("broadcast") ?? "";
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next);
    setOffset(0);
  };
  const { data, error } = useLoad(() => api.get<Data>(`/api/admin/messages/deliveries${query({ channel, status, broadcast, q, limit: LIMIT, offset })}`),
    [channel, status, broadcast, q, offset]);
  const s = data?.summary;
  const okPct = s && s.all_rows ? Math.round((s.ok / s.all_rows) * 100) : null;

  return (
    <>
      <PageTitle title="Levering" icon={<Activity size={24} strokeWidth={2} />}>
        Hver besked bliver til én levering pr. modtager og kanal. Her ser du, hvad der kom frem, hvad der venter på stilletimer, og
        hvad udbyderne afviste. Telefonnumre og e-mails vises maskeret.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={grid}>
        <Stat label="Leveret · 24 t" value={okPct === null ? "—" : `${okPct} %`} />
        <Stat label="Holdt · stilletimer" value={s?.held ?? "—"} />
        <Stat label="Fejlet · 24 t" value={s?.failed ?? "—"} tone={s?.failed ? "bad" : undefined} />
        <Stat label="SMS-segmenter · 24 t" value={s?.sms_segments ?? "—"} />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div role="tablist" aria-label="Kanal" style={{ display: "flex", gap: 2, padding: 2, borderRadius: 8, background: "#e2e8f0" }}>
          {TABS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={channel === k} onClick={() => set("channel", k)}
              style={{ border: 0, padding: "6px 12px", borderRadius: 6, cursor: "pointer", font: `${channel === k ? 600 : 500} 13px var(--hm-font-sans)`,
                background: channel === k ? "#fff" : "transparent", color: channel === k ? "#020817" : "#475569",
                boxShadow: channel === k ? "0 1px 2px rgba(0,0,0,0.08)" : "none" }}>{l}</button>
          ))}
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 }}>Status
          <select value={status} onChange={(e) => set("status", e.target.value)} style={{ ...select, minWidth: 150 }}>
            <option value="">Alle</option><option value="sent">Sendt</option><option value="delivered">Leveret</option>
            <option value="read">Læst</option><option value="held">Holdt</option><option value="failed">Fejlet</option>
            <option value="duplicate">Dublet</option><option value="throttled">Droslet</option><option value="skipped">Sprunget over</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500, flex: 1, minWidth: 200 }}>Søg modtager eller besked
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Navn eller overskrift" style={input} />
        </label>
        {broadcast && <button type="button" onClick={() => set("broadcast", "")} style={{ border: 0, background: "transparent", color: "#2563eb", cursor: "pointer", fontSize: 13 }}>
          Vis alle udsendelser</button>}
      </div>

      <div style={{ ...card, overflowX: "auto" }}>
        <div style={{ minWidth: 820 }}>
          <div style={{ ...tableHead, gridTemplateColumns: COLS }}>
            <span>Tidspunkt</span><span>Besked</span><span>Modtager</span><span>Kanal</span><span>Status</span><span>Detalje</span>
          </div>
          {data && data.items.length === 0 && <Empty>Ingen leveringer.</Empty>}
          {data?.items.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center", padding: "10px 16px",
              borderBottom: "1px solid #e2e8f0", fontSize: 13 }}>
              <span style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>{when(r.sent_at ?? r.created_at)}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.title}>{r.title}</span>
              <span style={{ fontWeight: 500 }}>{r.display_name}</span>
              <span>{CHANNEL[r.channel] ?? r.channel}</span>
              <span><StatusPill status={r.status} /></span>
              <span style={{ color: "#475569" }}>{detail(r)}</span>
            </div>
          ))}
        </div>
      </div>
      {data && data.total > LIMIT && <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </>
  );
}
