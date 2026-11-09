// /admin/resources → Ressourcer. Everything the instance uses — server, Postgres, events, Object Storage, NATS,
// AI, e-mail/SMS and the job queue — with use, limit and an estimated monthly price (/api/admin/resources).
// Limits the app cannot measure and the prices are set in "Priser og grænser" (PUT /api/admin/resources/config).
// Below the table: kill switches, automatic rules and events by kind (./ResourcesControl).
import { useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, Download, Gauge, RefreshCw, SlidersHorizontal } from "lucide-react";
import { api, errorText } from "../../api";
import { card, fmt, input, label as labelStyle } from "../theme";
import { Btn, CloseBtn, Drawer, ErrorBox, fmtBytes, PageTitle, useLoad, useToast } from "../ui";
import ResourcesControl from "./ResourcesControl";

type Unit = "bytes" | "vcpu" | "count" | "tokens" | "seconds";
type PriceUnit = "gb" | "mtokens" | "piece" | null;
type Status = "ok" | "warn" | "crit" | "none" | "info" | "error";
type ItemConfig = { max: number | null; monthly: number | null; unit_price: number | null };
type Item = {
  key: string; category: string; name: string; source: string; unit: Unit; price_unit: PriceUnit;
  used: number | null; max: number | null; max_measured: boolean; pct: number | null; note: string | null;
  status: Status; status_label: string; cost: number | null; config?: ItemConfig;
};
type Category = { key: string; label: string; items: Item[]; cost: number | null };
type Overview = {
  measured_at: string; currency: string; categories: Category[]; total_cost: number | null; count: number; near_limit: number;
  events: { bus: "nats" | "postgres"; nats_configured: boolean; stream: string; ttl_days: number };
};

type Filter = "alle" | "graense" | "pris" | "naer";
const FILTERS: [Filter, string][] = [["alle", "Alle"], ["graense", "Med grænse"], ["pris", "Med pris"], ["naer", "Tæt på grænsen"]];

const STATUS: Record<Status, { bar: string; text: string; bg: string; fg: string }> = {
  ok: { bar: "#2563eb", text: "#1d4ed8", bg: "rgba(22,163,74,0.12)", fg: "#166534" },
  warn: { bar: "#ea580c", text: "#9a3412", bg: "rgba(249,115,22,0.12)", fg: "#9a3412" },
  crit: { bar: "#dc2626", text: "#b91c1c", bg: "rgba(220,38,38,0.1)", fg: "#b91c1c" },
  none: { bar: "#cbd5e1", text: "#64748b", bg: "#f1f5f9", fg: "#475569" },
  info: { bar: "#2563eb", text: "#1d4ed8", bg: "rgba(37,99,235,0.1)", fg: "#1d4ed8" },
  error: { bar: "#cbd5e1", text: "#b91c1c", bg: "rgba(220,38,38,0.1)", fg: "#b91c1c" },
};
const CATEGORY_COLORS = ["#1e40af", "#f59e0b", "#0d9488", "#7c3aed", "#db2777", "#94a3b8"];

const dec = (v: number, digits = 1) => v.toLocaleString("da-DK", { maximumFractionDigits: digits });

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return h ? `${d} d ${h} t` : `${d} ${d === 1 ? "dag" : "dage"}`;
  if (h) return `${h} t ${m} min`;
  return `${m} min`;
}

function value(unit: Unit, v: number): string {
  switch (unit) {
    case "bytes": return fmtBytes(v);
    case "vcpu": return `${dec(v, 2)} vCPU`;
    case "tokens": return v >= 1_000_000 ? `${dec(v / 1_000_000)} mio.` : fmt(v);
    case "seconds": return duration(v);
    default: return fmt(v);
  }
}

const money = (v: number | null, currency: string) =>
  v === null ? "—" : `${v.toLocaleString("da-DK", { maximumFractionDigits: v < 10 ? 2 : 0 })} ${currency}`;

const PRICE_UNIT: Record<Exclude<PriceUnit, null>, string> = { gb: "pr. GB", mtokens: "pr. mio. tokens", piece: "pr. stk." };
const MAX_UNIT: Record<Unit, string> = { bytes: "GB", vcpu: "vCPU", count: "antal", tokens: "tokens", seconds: "sekunder" };

const grid: CSSProperties = {
  display: "grid", gridTemplateColumns: "minmax(230px, 2.3fr) minmax(240px, 2.4fr) 64px 110px 130px", gap: 16, alignItems: "center",
};

export default function Resources() {
  const [tick, setTick] = useState(0);
  const load = useLoad(() => api.get<Overview>("/api/admin/resources"), [tick]);
  const [filter, setFilter] = useState<Filter>("alle");
  const [editing, setEditing] = useState(false);
  const o = load.data;

  const items = useMemo(() => (o ? o.categories.flatMap((c) => c.items) : []), [o]);
  const attention = items.filter((i) => i.status === "warn" || i.status === "crit");
  const keep = (i: Item) =>
    filter === "alle" || (filter === "graense" && i.max !== null) || (filter === "pris" && i.cost !== null)
    || (filter === "naer" && (i.status === "warn" || i.status === "crit"));
  const priced = (o?.categories ?? []).filter((c) => c.cost);

  function downloadCsv() {
    if (!o) return;
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [["Kategori", "Ressource", "Kilde", "Brugt", "Maks", "Andel %", `Pris/md (${o.currency})`, "Status"].join(";")];
    for (const c of o.categories) for (const i of c.items) {
      lines.push([c.label, i.name, i.source, i.used ?? "", i.max ?? "", i.pct ?? "", i.cost ?? "", i.status_label].map((v) => esc(String(v))).join(";"));
    }
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ressourcer-${o.measured_at.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const title = (
    <PageTitle title="Ressourcer" icon={<Gauge size={24} />} aside={
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {o && <span style={{ fontSize: 12, color: "#64748b" }}>Målt kl. {new Date(o.measured_at).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}</span>}
        <Btn icon={RefreshCw} onClick={() => setTick((t) => t + 1)} disabled={load.loading} deeplink="resources-refresh">Mål igen</Btn>
        <Btn icon={Download} onClick={downloadCsv} disabled={!o}>Hent CSV</Btn>
        <Btn icon={SlidersHorizontal} kind="primary" onClick={() => setEditing(true)} disabled={!o} deeplink="resources-config">Priser og grænser</Btn>
      </div>
    }>
      Alt instansen bruger: server, database, hændelser, Object Storage, NATS og eksterne tjenester. Forbrug, grænse og anslået
      pris pr. måned. Priserne beregnes ud fra de enhedspriser, du sætter under "Priser og grænser".
    </PageTitle>
  );

  if (load.error) return <>{title}<ErrorBox>{load.error}</ErrorBox></>;
  if (!o) return title;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {title}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Kpi label="Anslået pris denne måned" value={money(o.total_cost, o.currency)}
          sub={o.total_cost === null ? "Sæt priser under Priser og grænser" : "Faste priser plus forbrug til nu"} />
        <Kpi label="Ressourcer i brug" value={fmt(o.count)} sub={`${o.categories.length} kategorier`} />
        <Kpi label="Tæt på grænsen" value={fmt(o.near_limit)} sub="Over 75 % af grænsen eller med fejl i driften" danger={o.near_limit > 0} />
        <div style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}>Pris pr. kategori</span>
          {priced.length === 0 ? <span style={{ fontSize: 13, color: "#64748b" }}>Ingen priser sat endnu</span> : <>
            <div style={{ display: "flex", height: 10, borderRadius: 9999, overflow: "hidden", background: "#f1f5f9" }}>
              {priced.map((c, i) => <span key={c.key} style={{ width: `${(c.cost! / o.total_cost!) * 100}%`, background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />)}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 12, color: "#475569" }}>
              {priced.map((c, i) => (
                <span key={c.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />{c.label} {money(c.cost, "")}
                </span>
              ))}
            </div>
          </>}
        </div>
      </div>

      {attention.length > 0 && (
        <section aria-labelledby="res-att" style={{ background: "#fffbeb", border: "1px solid rgba(245,158,11,0.45)", borderRadius: 16, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 id="res-att" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#78350f", display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} />Kræver opmærksomhed
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 24px", fontSize: 13, color: "#78350f" }}>
            {attention.map((i) => (
              <span key={i.key}>
                <strong>{o.categories.find((c) => c.key === i.category)?.label} · {i.name}</strong>{" "}
                {i.used !== null && i.max !== null ? `${value(i.unit, i.used)} af ${value(i.unit, i.max)}` : ""}
                {i.pct !== null ? ` · ${dec(i.pct, 0)} %` : ""}{i.note ? ` · ${i.note}` : ""}
              </span>
            ))}
          </div>
        </section>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div role="group" aria-label="Filter" style={{ display: "flex", gap: 2, padding: 3, borderRadius: 10, background: "#e2e8f0", flexWrap: "wrap" }}>
          {FILTERS.map(([key, text]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} data-deeplink={`resources-filter-${key}`}
              style={{ height: 30, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer", font: "500 13px var(--hm-font-sans)",
                background: filter === key ? "#ffffff" : "transparent", color: filter === key ? "#020817" : "#475569",
                boxShadow: filter === key ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
              {text}
            </button>
          ))}
        </div>
        <span style={{ flex: "1 1 auto" }} />
        <span style={{ fontSize: 12, color: "#64748b" }}>
          Farve: <span style={{ color: STATUS.ok.text, fontWeight: 600 }}>under 75 %</span> · <span style={{ color: STATUS.warn.text, fontWeight: 600 }}>75–89 %</span> · <span style={{ color: STATUS.crit.text, fontWeight: 600 }}>90 % og derover</span>
        </span>
      </div>

      <div style={{ ...card, overflowX: "auto" }}>
        <div style={{ minWidth: 900 }}>
          <div style={{ ...grid, padding: "12px 20px", borderBottom: "1px solid #e2e8f0", fontSize: 12, fontWeight: 600, color: "#64748b" }}>
            <span>Ressource</span><span>Brugt / maks.</span><span style={{ textAlign: "right" }}>Andel</span><span style={{ textAlign: "right" }}>Pris / md.</span><span>Status</span>
          </div>
          {o.categories.map((c) => {
            const shown = c.items.filter(keep);
            if (!shown.length) return null;
            return (
              <div key={c.key}>
                <div style={{ padding: "14px 20px 6px", display: "flex", alignItems: "baseline", gap: 10, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</span>
                  {c.key === "events" && <span style={{ fontSize: 12, color: "#64748b" }}>
                    {o.events.bus === "nats" ? `Via NATS (${o.events.stream})` : "Direkte i Postgres"} · gemmes {o.events.ttl_days} dage</span>}
                  <span style={{ flex: "1 1 auto" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>{c.cost !== null ? money(c.cost, o.currency) : ""}</span>
                </div>
                {shown.map((i) => <Row key={i.key} i={i} currency={o.currency} />)}
              </div>
            );
          })}
          <div style={{ ...grid, padding: "14px 20px", fontWeight: 700 }}>
            <span>I alt pr. måned</span><span /><span /><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(o.total_cost, o.currency)}</span><span />
          </div>
        </div>
      </div>

      <ResourcesControl tick={tick} />

      <p style={{ margin: 0, fontSize: 12, color: "#64748b", maxWidth: 860 }}>
        Server og container måles i app-containeren (cgroup), Postgres med pg_database_size og max_connections, hændelser fra
        NATS-streamen og events-tabellen — hændelser ældre end {o.events.ttl_days} dage slettes af oprydningen. Object Storage tælles
        fra de filer appen har gemt, NATS fra overvågningsporten, AI fra ai_usage og e-mail/SMS fra login-koderne i auth-loggen.
        Månedstal gælder fra den 1. i måneden.
      </p>

      {editing && <ConfigDrawer items={items} currency={o.currency} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setTick((t) => t + 1); }} />}
    </div>
  );
}

function Kpi({ label, value: v, sub, danger }: { label: string; value: string; sub: string; danger?: boolean }) {
  return (
    <div style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "#64748b" }}>{label}</span>
      <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: danger ? "#b91c1c" : "#020817" }}>{v}</span>
      <span style={{ fontSize: 12, color: "#475569" }}>{sub}</span>
    </div>
  );
}

function Row({ i, currency }: { i: Item; currency: string }) {
  const s = STATUS[i.status];
  const maxText = i.max === null ? (i.status === "error" ? "" : "ingen grænse") : `af ${value(i.unit, i.max)}${i.max_measured ? "" : " (sat her)"}`;
  return (
    <div style={{ ...grid, padding: "12px 20px", borderBottom: "1px solid #f1f5f9" }} data-deeplink={`resource-${i.key}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{i.name}</span>
        <span style={{ fontSize: 12, color: "#64748b", overflowWrap: "anywhere" }}>{i.source}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13 }}>
          {i.used !== null && <strong style={{ fontWeight: 600 }}>{value(i.unit, i.used)} </strong>}
          <span style={{ color: "#64748b" }}>{maxText}</span>
          {i.note && <span style={{ color: s.text }}> · {i.note}</span>}
        </span>
        {i.pct !== null && (
          <div style={{ height: 6, borderRadius: 9999, background: "#f1f5f9", overflow: "hidden" }}>
            <div style={{ height: 6, borderRadius: 9999, width: `${Math.min(100, i.pct)}%`, background: s.bar }} />
          </div>
        )}
      </div>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: s.text }}>{i.pct === null ? "–" : `${dec(i.pct, 0)} %`}</span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(i.cost, currency)}</span>
      <span>
        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 9999, whiteSpace: "nowrap", background: s.bg, color: s.fg }}>{i.status_label}</span>
      </span>
    </div>
  );
}

type Draft = Record<string, { max: string; monthly: string; unit_price: string }>;
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const parse = (v: string): number | null => {
  const t = v.trim().replace(",", ".");
  return t === "" ? null : Number(t);
};

function ConfigDrawer({ items, currency, onClose, onSaved }: { items: Item[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const say = useToast();
  const editable = items.filter((i) => i.status !== "error");
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(editable.map((i) => [i.key, {
    max: str(i.config?.max), monthly: str(i.config?.monthly), unit_price: str(i.config?.unit_price),
  }])));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: string, field: "max" | "monthly" | "unit_price", v: string) => setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: v } }));

  async function save() {
    const out: Record<string, ItemConfig> = {};
    for (const [key, d] of Object.entries(draft)) {
      const c = { max: parse(d.max), monthly: parse(d.monthly), unit_price: parse(d.unit_price) };
      if (Object.values(c).some((v) => v !== null && (!Number.isFinite(v) || v < 0))) {
        setError("Brug tal på 0 eller derover.");
        return;
      }
      if (Object.values(c).some((v) => v !== null)) out[key] = c;
    }
    setSaving(true);
    try {
      await api.put("/api/admin/resources/config", { items: out });
      say("Priser og grænser er gemt");
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const field: CSSProperties = { ...input, width: "100%" };
  return (
    <Drawer width={520} onClose={onClose} label="Priser og grænser" deeplink="resources-config-drawer">
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid #e2e8f0" }}>
        <span style={{ flex: 1, fontSize: 17, fontWeight: 700 }}>Priser og grænser</span>
        <CloseBtn onClick={onClose} />
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
          Grænse: bruges når appen ikke selv kan måle den (fx Object Storage-kvote eller en mailplan) og går forud for den målte.
          Fast pris: beløb pr. måned (fx serveren). Enhedspris: ganges med forbruget. Tomme felter tæller ikke med. Priser i {currency}
        </p>
        {editable.map((i) => (
          <fieldset key={i.key} style={{ margin: 0, padding: 14, border: "1px solid #e2e8f0", borderRadius: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <legend style={{ padding: "0 6px", fontSize: 13, fontWeight: 600 }}>{i.name} <span style={{ fontWeight: 400, color: "#64748b" }}>· {i.source}</span></legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
              <label style={labelStyle}>
                Grænse ({MAX_UNIT[i.unit]})
                <input inputMode="decimal" style={field} value={draft[i.key]?.max ?? ""} onChange={(e) => set(i.key, "max", e.target.value)}
                  placeholder={i.max_measured && i.max !== null ? `målt: ${i.unit === "bytes" ? dec(i.max / 1e9) : dec(i.max, 2)}` : ""} />
              </label>
              <label style={labelStyle}>
                Fast pris / md.
                <input inputMode="decimal" style={field} value={draft[i.key]?.monthly ?? ""} onChange={(e) => set(i.key, "monthly", e.target.value)} />
              </label>
              {i.price_unit && (
                <label style={labelStyle}>
                  Enhedspris ({PRICE_UNIT[i.price_unit]})
                  <input inputMode="decimal" style={field} value={draft[i.key]?.unit_price ?? ""} onChange={(e) => set(i.key, "unit_price", e.target.value)} />
                </label>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", padding: "14px 20px", borderTop: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        {error && <span role="alert" style={{ flex: 1, fontSize: 13, color: "#b91c1c" }}>{error}</span>}
        <Btn onClick={onClose}>Annuller</Btn>
        <Btn kind="primary" onClick={save} disabled={saving}>{saving ? "Gemmer …" : "Gem"}</Btn>
      </div>
    </Drawer>
  );
}
