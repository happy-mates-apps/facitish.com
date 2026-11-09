// /admin/adoption: the section layout (journey picker, period, tracking banner) and the small parts the pages share.
// Design: the "Adoption Module" canvas (ported from surdej-v1 modules/member-adoption).
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Check, ChevronDown, Plus } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, useLoad, useToast } from "../../ui";
import { card, fmt, MONO, SANS } from "../../theme";
import type { MatchType } from "./match";

export type Status = "draft" | "active" | "paused";
export type Step = { id?: number; label: string; match_type: MatchType; pattern: string };
export type Audience = { kind: "all" } | { kind: "role"; roles: ("user" | "admin")[] } | { kind: "users"; user_ids: number[] };
export type Journey = {
  id: number; name: string; status: Status; audience: Audience; audience_text: string; goal_pct: number;
  start_at: string; end_at: string | null; steps: Step[]; cohort_size: number; reached: number[]; done_pct: number;
  my_role: "reader" | "editor" | "owner" | "admin"; can_edit: boolean; can_manage: boolean;
};
export type Settings = { tracking: boolean; retention_days: number | null; nudge_webhooks: number; sees_all: boolean };
export type Days = 7 | 30 | 90;
export type Draft = { label: string; match_type: MatchType; pattern: string };

type AdoptionState = {
  days: Days; setDays: (d: Days) => void;
  journeys: Journey[] | null; reloadJourneys: () => Promise<void>;
  selectedId: number | null; select: (id: number) => void;
  settings: Settings | null; reloadSettings: () => Promise<void>;
  draft: Draft | null; setDraft: (d: Draft | null) => void;
};

const Ctx = createContext<AdoptionState | null>(null);
export const useAdoption = () => useContext(Ctx)!;

const SECTIONS: Record<string, [eyebrow: string, title: string]> = {
  "": ["Overblik", "Hvem bruger hvad — og hvor meget"],
  journeys: ["Forløb", "Forløb"],
  routes: ["Ruter og URL'er", "Alle sporede ruter"],
  console: ["Live-strøm", "Live rutebesøg"],
  access: ["Adgang", "Hvem må se og ændre forløb"],
};

function readDays(): Days {
  try {
    const v = Number(localStorage.getItem("gaer.adoption.days"));
    return v === 7 || v === 90 ? v : 30;
  } catch {
    return 30;
  }
}

export function AdoptionLayout() {
  const [days, setDaysState] = useState<Days>(readDays);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const journeys = useLoad(() => api.get<{ items: Journey[] }>("/api/admin/adoption/journeys").then((r) => r.items), []);
  const settings = useLoad(() => api.get<Settings>("/api/admin/adoption/settings"), []);
  const { pathname } = useLocation();
  const section = pathname.split("/")[2] ?? "";
  const [eyebrow, title] = SECTIONS[section] ?? SECTIONS[""];
  const selected = journeys.data?.find((j) => j.id === selectedId) ?? journeys.data?.[0] ?? null;

  const setDays = (d: Days) => {
    setDaysState(d);
    try { localStorage.setItem("gaer.adoption.days", String(d)); } catch { /* storage blocked */ }
  };
  const state: AdoptionState = {
    days, setDays, journeys: journeys.data, reloadJourneys: journeys.reload, selectedId: selected?.id ?? null, select: setSelectedId,
    settings: settings.data, reloadSettings: settings.reload, draft, setDraft,
  };

  return (
    <Ctx.Provider value={state}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>Adoption · {eyebrow}</span>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {section === "journeys" && selected ? selected.name : title}
          </h1>
        </div>
        {section !== "access" && <JourneyPicker />}
        {(section === "" || section === "routes") && (
          <Seg<Days> label="Periode" round value={days} onChange={setDays}
            options={[{ value: 7, label: "7 d" }, { value: 30, label: "30 d" }, { value: 90, label: "90 d" }]} />
        )}
      </div>
      {settings.data && !settings.data.tracking && <TrackingOff settings={settings.data} reload={settings.reload} />}
      {(journeys.error || settings.error) && <ErrorBox>{journeys.error || settings.error}</ErrorBox>}
      <Outlet />
    </Ctx.Provider>
  );
}

function TrackingOff({ settings, reload }: { settings: Settings; reload: () => Promise<void> }) {
  const say = useToast();
  const turnOn = async () => {
    if (!confirm("Slå sporing til? Fra nu af gemmes hvilke sider indloggede brugere åbner i appen, på /m og i udvidelsen. "
      + `Besøgene slettes efter ${settings.retention_days ?? 180} dage og er med i brugernes GDPR-indsigt.`)) return;
    try {
      await api.put("/api/admin/adoption/settings", { tracking: true });
      say("Sporingen er slået til");
      await reload();
    } catch (e) {
      say(errorText(e));
    }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 12,
      background: "#fffbeb", border: "1px solid rgba(245,158,11,0.4)", color: "#78350f", fontSize: 13 }}>
      <span style={{ flex: "1 1 320px" }}>
        <b>Sporingen er slået fra.</b> Ingen sidebesøg bliver gemt, så forløbene måler ikke noget nyt.
        {!settings.sees_all && " En admin med Fuld adgang kan slå den til."}
      </span>
      {settings.sees_all && <Btn kind="primary" onClick={turnOn}>Slå sporing til</Btn>}
    </div>
  );
}

function JourneyPicker() {
  const { journeys, selectedId, select, reloadJourneys } = useAdoption();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const say = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const selected = journeys?.find((j) => j.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (id: number) => {
    select(id);
    setOpen(false);
    navigate(`/adoption/journeys/${id}${pathname.endsWith("/setup") ? "/setup" : ""}`);
  };
  const create = async () => {
    setOpen(false);
    try {
      const j = await api.post<Journey>("/api/admin/adoption/journeys", { name: "Nyt forløb" });
      await reloadJourneys();
      select(j.id);
      navigate(`/adoption/journeys/${j.id}/setup`);
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox"
        style={{ display: "flex", alignItems: "center", gap: 10, height: 44, minWidth: 280, padding: "0 12px", border: "1px solid #e2e8f0",
          borderRadius: 8, background: "#ffffff", color: "#020817", font: `14px ${SANS}`, cursor: "pointer", textAlign: "left" }}>
        <span style={{ width: 8, height: 8, flex: "none", borderRadius: 9999, background: selected ? STATUS[selected.status][2] : "#94a3b8" }} />
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontSize: 11, color: "#64748b" }}>Adoptionsforløb</span>
          <b style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
            {selected?.name ?? (journeys ? "Ingen forløb endnu" : "…")}
          </b>
        </span>
        {selected && <b style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{selected.done_pct} %</b>}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div role="listbox" style={{ position: "absolute", right: 0, top: 50, zIndex: 30, width: 340, maxWidth: "calc(100vw - 48px)", padding: 6,
          ...card, borderRadius: 12, boxShadow: "0 20px 40px -16px rgba(2,8,23,.3)", display: "flex", flexDirection: "column", gap: 2 }}>
          {(journeys ?? []).map((j) => (
            <button key={j.id} type="button" role="option" aria-selected={j.id === selectedId} onClick={() => pick(j.id)} className="tg-hover"
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 10px", padding: "10px 12px",
                borderRadius: 8, background: j.id === selectedId ? "#f1f5f9" : "transparent" }}>
              <b style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.name}</b>
              <b style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{j.done_pct} %</b>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b" }}>
                <StatusPill status={j.status} /> {j.steps.length} trin · {fmt(j.cohort_size)} brugere
              </span>
              <Bar value={j.done_pct} height={4} style={{ width: 56, alignSelf: "center" }} />
            </button>
          ))}
          <button type="button" onClick={create} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, padding: 12, border: 0,
            borderTop: "1px solid #e2e8f0", background: "transparent", color: "#2563eb", font: `500 13px ${SANS}`, cursor: "pointer" }}>
            <Plus size={14} />Nyt forløb
          </button>
        </div>
      )}
    </div>
  );
}

// ── Small parts ─────────────────────────────────────────────────────────────

export const STATUS: Record<Status, [label: string, colors: CSSProperties, dot: string]> = {
  active: ["Aktiv", { background: "#dcfce7", color: "#166534" }, "#22c55e"],
  paused: ["Pauset", { background: "#fef3c7", color: "#92400e" }, "#f59e0b"],
  draft: ["Kladde", { background: "#f1f5f9", color: "#475569" }, "#94a3b8"],
};

export function StatusPill({ status }: { status: Status }) {
  return <span style={{ padding: "1px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", ...STATUS[status][1] }}>{STATUS[status][0]}</span>;
}

export function Seg<T extends string | number>({ options, value, onChange, label, round }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; round?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 2, padding: 3, borderRadius: round ? 9999 : 8,
      background: round ? "#e2e8f0" : "#f1f5f9" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            style={{ border: 0, cursor: "pointer", whiteSpace: "nowrap", padding: round ? "6px 12px" : "5px 10px", borderRadius: round ? 9999 : 6,
              font: `500 ${round ? 13 : 12}px ${SANS}`, background: on ? "#ffffff" : "transparent", color: on ? "#020817" : "#475569",
              boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none" }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Bar({ value, fill = "#2563eb", height = 8, style }: { value: number; fill?: string; height?: number; style?: CSSProperties }) {
  return (
    <span style={{ display: "block", height, borderRadius: 9999, background: "#f1f5f9", overflow: "hidden", ...style }}>
      <span style={{ display: "block", height: "100%", borderRadius: 9999, width: `${Math.max(0, Math.min(100, value))}%`, background: fill,
        transition: "width .6s" }} />
    </span>
  );
}

export function Spark({ values }: { values: number[] }) {
  const vals = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const max = Math.max(...vals);
  const min = Math.min(...vals) * 0.8;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / (max - min || 1)) * 26).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" style={{ width: "100%", height: 32, marginTop: 6 }} aria-hidden="true">
      <polygon points={`0,32 ${pts} 100,32`} fill="#2563eb" opacity={0.1} />
      <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Panel({ title, sub, action, dark, children, style }: {
  title: ReactNode; sub?: ReactNode; action?: ReactNode; dark?: boolean; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20, borderRadius: 16, minWidth: 0,
      ...(dark ? { background: "#020817", color: "#e2e8f0" } : { ...card }), ...style }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: dark ? "#ffffff" : undefined }}>{title}</h3>
          {sub && <p style={{ margin: "2px 0 0", fontSize: 13, color: dark ? "#94a3b8" : "#64748b" }}>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, dot, children }: { label: string; value: ReactNode; sub?: ReactNode; dot?: string; children?: ReactNode }) {
  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 4, padding: "16px 18px", minWidth: 0 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#64748b" }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 9999, background: dot }} />}{label}
      </span>
      <b style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{value}</b>
      {sub && <span style={{ fontSize: 12, color: "#64748b" }}>{sub}</span>}
      {children}
    </div>
  );
}

export function Trend({ value, unit = "%" }: { value: number | null; unit?: string }) {
  if (value === null) return null;
  const [text, color] = value > 0 ? [`▲ ${value} ${unit}`, "#16a34a"] : value < 0 ? [`▼ ${Math.abs(value)} ${unit}`, "#dc2626"] : [`• 0 ${unit}`, "#64748b"];
  return <b style={{ color, fontWeight: 600 }}>{text}</b>;
}

export function Code({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <code style={{ fontFamily: MONO, fontSize: 12, ...style }}>{children}</code>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, padding: 40, textAlign: "center", fontSize: 14, color: "#64748b", ...card, borderStyle: "dashed" }}>{children}</p>;
}

export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
export const decimal = (v: number) => v.toLocaleString("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const shortDate = (d: Date, year = false) =>
  d.toLocaleDateString("da-DK", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) }).replace(/\.$/, "");

export function periodLabel(start: string, end: string | null): string {
  const s = new Date(start);
  if (s > new Date()) return `Starter ${shortDate(s, true)}`;
  if (!end) return `Fra ${shortDate(s, true)}`;
  return `${shortDate(s)} – ${shortDate(new Date(end), true)}`;
}

export const initials = (name: string | null) =>
  (name ?? "?").split(/[\s.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

export const SentCheck = () => <Check size={12} aria-hidden="true" />;
