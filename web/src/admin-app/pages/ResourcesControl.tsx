// The control half of /admin/resources: kill switches (nødstop), automatic rules and events by kind.
// GET /api/admin/resources/control · PUT /api/admin/resources/killswitches/{key} · PUT /api/admin/resources/rules.
import { useEffect, useState, type CSSProperties } from "react";
import { OctagonX, Plus, Power, Trash2, Zap } from "lucide-react";
import { api, errorText } from "../../api";
import { card, fmt, input, MONO, select } from "../theme";
import { Btn, ErrorBox, fmtDate, IconBtn, Modal, Toggle, useLoad, useToast } from "../ui";

type Switch = {
  key: string; label: string; description: string; closed: boolean; reason: string; auto: boolean;
  set_at: string | null; expires_at: string | null; set_by_name: string | null;
};
type Rule = { kind: string; threshold: number; window_seconds: number; switch: string; minutes: number | null; enabled: boolean };
type Kind = { kind: string; m5: number; h1: number; d1: number; last_seen: string; description: string | null };
type Control = {
  switches: Switch[]; rules: Rule[]; kinds: Kind[]; known_kinds: { kind: string; description: string | null }[];
  bus: "nats" | "postgres"; nats_configured: boolean; rules_seconds: number;
};

const DURATIONS: [number | null, string][] = [[null, "Indtil jeg åbner igen"], [15, "15 minutter"], [60, "1 time"], [240, "4 timer"], [1440, "24 timer"]];
const WINDOWS: [number, string][] = [[30, "30 sek."], [60, "1 min."], [300, "5 min."], [900, "15 min."], [3600, "1 time"]];
const RULE_MINUTES: [number | null, string][] = [[5, "5 min."], [15, "15 min."], [60, "1 time"], [240, "4 timer"], [1440, "24 timer"], [null, "indtil åbnet"]];

const h2: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 };
const muted: CSSProperties = { margin: 0, fontSize: 13, color: "#64748b" };
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }) : "");

export default function ResourcesControl({ tick }: { tick: number }) {
  const [own, setOwn] = useState(0);
  const load = useLoad(() => api.get<Control>("/api/admin/resources/control"), [tick, own]);
  const reload = () => setOwn((t) => t + 1);
  const c = load.data;
  if (load.error) return <ErrorBox>{load.error}</ErrorBox>;
  if (!c) return null;
  return (
    <>
      <Switches c={c} onChanged={reload} />
      <Rules c={c} onSaved={reload} />
      <Kinds c={c} />
    </>
  );
}

// ── Nødstop ─────────────────────────────────────────────────────────────────

function Switches({ c, onChanged }: { c: Control; onChanged: () => void }) {
  const say = useToast();
  const [closing, setClosing] = useState<Switch | null>(null);
  const anyClosed = c.switches.some((s) => s.closed);

  async function open(s: Switch) {
    try {
      await api.put(`/api/admin/resources/killswitches/${s.key}`, { closed: false });
      say(`${s.label} er åbnet igen`);
      onChanged();
    } catch (e) {
      say(errorText(e));
    }
  }

  return (
    <section aria-labelledby="res-kill" style={{ ...card, padding: 0, overflow: "hidden" }} data-deeplink="resources-killswitches">
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4, borderBottom: "1px solid #e2e8f0",
        background: anyClosed ? "#fef2f2" : "#ffffff" }}>
        <h2 id="res-kill" style={h2}><OctagonX size={18} color={anyClosed ? "#b91c1c" : "#020817"} />Nødstop</h2>
        <p style={muted}>
          Luk hele tjenesten eller dele af den. Et lukket område svarer »midlertidigt lukket« inden for et par sekunder i alle
          containere. /admin, login og /health lukker aldrig, så du kan altid åbne igen. Alt logges i audit-loggen.
        </p>
      </div>
      {c.switches.map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "14px 20px", borderBottom: "1px solid #f1f5f9" }}
          data-deeplink={`killswitch-${s.key}`}>
          <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {s.label}
              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 9999,
                background: s.closed ? "rgba(220,38,38,0.1)" : "rgba(22,163,74,0.12)", color: s.closed ? "#b91c1c" : "#166534" }}>
                {s.closed ? (s.auto ? "Lukket af regel" : "Lukket") : "Åben"}
              </span>
            </span>
            <span style={{ fontSize: 13, color: "#64748b" }}>{s.description}</span>
            {s.closed && (
              <span style={{ fontSize: 13, color: "#b91c1c" }}>
                {s.reason}{s.set_by_name && !s.auto ? ` · ${s.set_by_name}` : ""}{s.set_at ? ` · ${time(s.set_at)}` : ""}
                {s.expires_at ? ` · åbner kl. ${time(s.expires_at)}` : " · til den åbnes igen"}
              </span>
            )}
          </div>
          {s.closed
            ? <Btn icon={Power} onClick={() => open(s)}>Åbn</Btn>
            : <Btn icon={OctagonX} onClick={() => setClosing(s)} style={s.key === "all" ? { borderColor: "rgba(220,38,38,0.4)", color: "#b91c1c" } : undefined}>Luk</Btn>}
        </div>
      ))}
      {closing && <CloseDialog s={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); onChanged(); }} />}
    </section>
  );
}

function CloseDialog({ s, onClose, onDone }: { s: Switch; onClose: () => void; onDone: () => void }) {
  const say = useToast();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      setError("Skriv hvorfor du lukker.");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/admin/resources/killswitches/${s.key}`, { closed: true, reason: reason.trim(), minutes });
      say(`${s.label} er lukket`);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal width={460} onClose={onClose}>
      <span style={{ fontSize: 17, fontWeight: 700 }}>Luk {s.label.toLowerCase()}?</span>
      <p style={muted}>{s.description}</p>
      {s.key === "all" && (
        <p role="alert" style={{ margin: 0, padding: "10px 12px", borderRadius: 10, background: "#fef2f2", color: "#b91c1c", fontSize: 13 }}>
          Alle brugere mister adgang til appen, indtil du åbner igen.
        </p>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 }}>
        Hvorfor?
        <input style={{ ...input, width: "100%" }} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Fx mistænkelig trafik" autoFocus />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 }}>
        Hvor længe?
        <select style={{ ...select, width: "100%" }} value={minutes ?? ""} onChange={(e) => setMinutes(e.target.value ? Number(e.target.value) : null)}>
          {DURATIONS.map(([m, text]) => <option key={text} value={m ?? ""}>{text}</option>)}
        </select>
      </label>
      {error && <span role="alert" style={{ fontSize: 13, color: "#b91c1c" }}>{error}</span>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn onClick={onClose}>Annuller</Btn>
        <Btn kind="primary" onClick={submit} disabled={busy} style={{ background: "#b91c1c" }}>{busy ? "Lukker …" : "Luk"}</Btn>
      </div>
    </Modal>
  );
}

// ── Automatiske regler ──────────────────────────────────────────────────────

function Rules({ c, onSaved }: { c: Control; onSaved: () => void }) {
  const say = useToast();
  const [rules, setRules] = useState<Rule[]>(c.rules);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRules(c.rules), [c.rules]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(c.rules);
  const set = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => setRules((rs) => [...rs, { kind: "http.5xx", threshold: 50, window_seconds: 60, switch: "all", minutes: 15, enabled: true }]);

  async function save() {
    setBusy(true);
    try {
      await api.put("/api/admin/resources/rules", { rules });
      setError(null);
      say("Reglerne er gemt");
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const cell: CSSProperties = { ...input, height: 32, width: "100%" };
  return (
    <section aria-labelledby="res-rules" style={{ ...card, padding: 0, overflow: "hidden" }} data-deeplink="resources-rules">
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id="res-rules" style={h2}><Zap size={18} />Automatiske regler</h2>
          <p style={muted}>
            Luk et område af sig selv, når en hændelse sker for tit. Reglerne tjekkes hvert {c.rules_seconds}. sekund mod alle
            containeres hændelser. Et område lukket af en regel åbner igen efter den valgte tid.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn icon={Plus} onClick={add}>Tilføj regel</Btn>
          <Btn kind="primary" onClick={save} disabled={!dirty || busy}>{busy ? "Gemmer …" : "Gem regler"}</Btn>
        </div>
      </div>
      {error && <div style={{ padding: "10px 20px" }}><ErrorBox>{error}</ErrorBox></div>}
      {rules.length === 0 ? <p style={{ ...muted, padding: "16px 20px" }}>Ingen regler endnu.</p> : (
        <div style={{ overflowX: "auto" }}>
          <datalist id="res-kinds">{c.known_kinds.map((k) => <option key={k.kind} value={k.kind}>{k.description ?? ""}</option>)}</datalist>
          {rules.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "44px minmax(150px, 1.4fr) 90px 110px minmax(150px, 1.3fr) 130px 36px", gap: 10,
              alignItems: "center", padding: "10px 20px", borderBottom: "1px solid #f1f5f9", minWidth: 820, fontSize: 13 }}>
              <Toggle on={r.enabled} onChange={() => set(i, { enabled: !r.enabled })} label="Regel slået til" />
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>Hvis hændelsen</span>
                <input list="res-kinds" style={{ ...cell, fontFamily: MONO }} value={r.kind} onChange={(e) => set(i, { kind: e.target.value.trim() })} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>sker mindst</span>
                <input type="number" min={1} style={cell} value={r.threshold} onChange={(e) => set(i, { threshold: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>gange på</span>
                <select style={{ ...select, height: 32 }} value={r.window_seconds} onChange={(e) => set(i, { window_seconds: Number(e.target.value) })}>
                  {WINDOWS.map(([s, text]) => <option key={s} value={s}>{text}</option>)}
                  {!WINDOWS.some(([s]) => s === r.window_seconds) && <option value={r.window_seconds}>{r.window_seconds} sek.</option>}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>så luk</span>
                <select style={{ ...select, height: 32 }} value={r.switch} onChange={(e) => set(i, { switch: e.target.value })}>
                  {c.switches.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>i</span>
                <select style={{ ...select, height: 32 }} value={r.minutes ?? ""} onChange={(e) => set(i, { minutes: e.target.value ? Number(e.target.value) : null })}>
                  {RULE_MINUTES.map(([m, text]) => <option key={text} value={m ?? ""}>{text}</option>)}
                </select>
              </label>
              <IconBtn icon={Trash2} label="Slet regel" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Hændelser ───────────────────────────────────────────────────────────────

function Kinds({ c }: { c: Control }) {
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(220px, 2fr) 80px 80px 90px 110px", gap: 12, alignItems: "center", minWidth: 620 };
  return (
    <section aria-labelledby="res-events" style={{ ...card, padding: 0, overflow: "hidden" }} data-deeplink="resources-events">
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4, borderBottom: "1px solid #e2e8f0" }}>
        <h2 id="res-events" style={h2}>Hændelser det seneste døgn</h2>
        <p style={muted}>
          {c.bus === "nats"
            ? "Hændelser går gennem NATS-streamen EVENTS (gemt 7 dage, kan afspilles igen) og gemmes i Postgres."
            : c.nats_configured
              ? "NATS svarer ikke lige nu: hændelser skrives direkte i Postgres, indtil forbindelsen er tilbage."
              : "NATS er ikke sat op: hændelser skrives direkte i Postgres."}{" "}
          Kun id'er og tal, ingen persondata. Gemmes 7 dage.
        </p>
      </div>
      {c.kinds.length === 0 ? <p style={{ ...muted, padding: "16px 20px" }}>Ingen hændelser det seneste døgn.</p> : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ ...grid, padding: "10px 20px", fontSize: 12, fontWeight: 600, color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>
            <span>Hændelse</span><span style={{ textAlign: "right" }}>5 min.</span><span style={{ textAlign: "right" }}>1 time</span>
            <span style={{ textAlign: "right" }}>24 timer</span><span>Sidst</span>
          </div>
          {c.kinds.map((k) => (
            <div key={k.kind} style={{ ...grid, padding: "10px 20px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontWeight: 600 }}>{k.kind}</span>
                {k.description && <span style={{ fontSize: 12, color: "#64748b" }}>{k.description}</span>}
              </span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(k.m5)}</span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(k.h1)}</span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(k.d1)}</span>
              <span style={{ color: "#64748b" }}>{fmtDate(k.last_seen)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
