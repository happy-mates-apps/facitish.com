// Udforsk → Forbindelser: every outside API the instance talks to — called from code (server/app/integrations.py) or
// connected in Forbind API — with keys (names and whether they are set, never values), endpoints and calls counted by
// the event api.call (GET /api/admin/data/connections). Design: the canvas "Data · Udforsk og Forbind API".
import { type CSSProperties, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Code, KeyRound, Plug, TriangleAlert } from "lucide-react";
import { api } from "../../../api";
import { Btn, ErrorBox, fmtDate, fmtDay, useLoad } from "../../ui";
import { card, fmt, input, MONO, sectionLabel, select } from "../../theme";
import { srOnly } from "./types";

type Endpoint = {
  method: string | null; path: string; label: string; called_from: string; calls: number; errors: number; p95_ms: number | null;
  last_at: string | null; last_error_at: string | null; dataset_id?: number | null;
};
type Stats = { calls: number; errors: number; p95_ms: number | null; last_at: string | null; last_error_at: string | null };
type CodeSecret = { name: string; set: boolean; where: "env" };
type SourceSecret = { ref: string; used_as: string; kind: "env" | "vault"; ok: boolean; how: string | null; text: string; secret_id: number | null;
  grant_expires_at: string | null; pending: { approved: number; total: number } | null };
type CodeConn = Stats & {
  key: string; kind: "code"; name: string; purpose: string; files: string[]; host: string | null; base_url: string | null; active: boolean;
  counted: boolean; link: string | null; secrets: CodeSecret[]; settings: { name: string; set: boolean }[]; endpoints: Endpoint[];
};
type SourceConn = Stats & {
  id: number; key: string; kind: "source"; name: string; host: string | null; hosts: string[]; auth: string | null; valid: boolean;
  active: true; counted: true; secrets: SourceSecret[]; endpoints: Endpoint[];
};
type Conn = CodeConn | SourceConn;
type Data = { hours: number; code: CodeConn[]; sources: SourceConn[] };

const AUTH: Record<string, string> = { ingen: "Ingen", bearer: "Bearer-token", header: "API-nøgle i header", basic: "Basic", oauth2: "OAuth 2" };
const T = {
  green: { bg: "rgba(22,163,74,0.12)", fg: "#166534", dot: "#16a34a" },
  orange: { bg: "rgba(249,115,22,0.12)", fg: "#9a3412", dot: "#ea580c" },
  red: { bg: "rgba(220,38,38,0.1)", fg: "#b91c1c", dot: "#dc2626" },
  gray: { bg: "#f1f5f9", fg: "#475569", dot: "#94a3b8" },
};
const idOf = (c: Conn) => (c.kind === "code" ? `code:${c.key}` : `source:${c.id}`);
const pct = (c: Stats) => (c.calls ? (100 * c.errors) / c.calls : 0);
const pctText = (c: Stats) => `${pct(c).toLocaleString("da-DK", { maximumFractionDigits: 1 })} %`;

function missingKey(c: Conn): boolean {
  return c.kind === "code" ? c.secrets.some((s) => !s.set) : c.secrets.some((s) => !s.ok);
}

export function statusOf(c: Conn): { label: string; tone: (typeof T)[keyof typeof T] } {
  if (c.kind === "code" && !c.active) return { label: "Ikke i brug", tone: T.gray };
  if (c.kind === "source" && !c.valid) return { label: "Beskrivelsen kan ikke læses", tone: T.red };
  if (missingKey(c)) return { label: c.kind === "code" ? "Mangler nøgle" : "Mangler adgang til hemmelighed", tone: T.orange };
  if (!c.counted) return { label: "Kald tælles ikke", tone: T.gray };
  if (!c.calls) return { label: "Ingen kald i perioden", tone: T.gray };
  if (pct(c) >= 5) return { label: `Fejl · ${pctText(c)}`, tone: T.red };
  return { label: `Kører · ${pctText(c)} fejl`, tone: T.green };
}

const pill = (tone: { bg: string; fg: string }): CSSProperties => ({ fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 9999, background: tone.bg, color: tone.fg, whiteSpace: "nowrap" });
const th: CSSProperties = { padding: "8px 12px", fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b", fontWeight: 600, textAlign: "left" };

export default function Connections() {
  const [params, setParams] = useSearchParams();
  const [hours, setHours] = useState(24);
  const [q, setQ] = useState("");
  const data = useLoad(() => api.get<Data>(`/api/admin/data/connections?hours=${hours}`), [hours]);
  const all: Conn[] = useMemo(() => [...(data.data?.code ?? []), ...(data.data?.sources ?? [])], [data.data]);
  const match = (c: Conn) => !q.trim() || `${c.name} ${c.host ?? ""} ${c.key}`.toLowerCase().includes(q.trim().toLowerCase());
  const code = (data.data?.code ?? []).filter((c) => c.active && match(c));
  const idle = (data.data?.code ?? []).filter((c) => !c.active && match(c));
  const sources = (data.data?.sources ?? []).filter(match);
  const chosenId = params.get("f") ?? (code[0] ? idOf(code[0]) : sources[0] ? idOf(sources[0]) : null);
  const chosen = all.find((c) => idOf(c) === chosenId) ?? null;
  const choose = (c: Conn) => setParams({ vis: "forbindelser", f: idOf(c) });

  const active = all.filter((c) => c.active);
  const totals = { calls: active.reduce((n, c) => n + c.calls, 0), errors: active.reduce((n, c) => n + c.errors, 0) };
  const envKeys = (data.data?.code ?? []).filter((c) => c.active).reduce((n, c) => n + c.secrets.filter((s) => s.set).length, 0)
    + (data.data?.sources ?? []).reduce((n, s) => n + s.secrets.filter((x) => x.kind === "env").length, 0);
  const period = hours === 24 ? "24 t" : "7 dage";

  if (data.error) return <ErrorBox>{data.error}</ErrorBox>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Tile label="Fra koden, i brug" value={`${(data.data?.code ?? []).filter((c) => c.active).length}`} sub={`af ${(data.data?.code ?? []).length} kendte`} />
        <Tile label="Forbundet i admin" value={`${(data.data?.sources ?? []).length}`} />
        <Tile label={`Kald sidste ${period}`} value={fmt(totals.calls)} sub={totals.calls ? `${fmt(totals.errors)} fejl` : undefined} />
        <Tile label="Nøgler i miljøvariabler" value={`${envKeys}`} warn={envKeys > 0} sub={envKeys ? "uden version, ansvarlig og rotation" : undefined} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section aria-label="Forbindelser" style={{ ...card, flex: "1 1 300px", maxWidth: "100%", padding: 12, display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "flex", flex: 1 }}><span style={srOnly}>Find forbindelse</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find navn eller vært" style={{ ...input, width: "100%" }} /></label>
            <label style={{ display: "flex" }}><span style={srOnly}>Periode</span>
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={select}>
                <option value={24}>24 t</option><option value={168}>7 dage</option>
              </select></label>
          </div>
          <Group title="I koden · kun læsning" items={code} chosen={chosenId} onChoose={choose} empty="Ingen i brug med de nuværende indstillinger" />
          <Group title="Forbundet i admin" items={sources} chosen={chosenId} onChoose={choose}
            empty={<>Ingen endnu. <Link to="/data/connect">Forbind et API</Link></>} />
          {idle.length > 0 && (
            <details>
              <summary style={{ ...sectionLabel, fontSize: 10, padding: "0 8px", cursor: "pointer" }}>Ikke i brug ({idle.length})</summary>
              <div style={{ marginTop: 6 }}><Group items={idle} chosen={chosenId} onChoose={choose} /></div>
            </details>
          )}
          <p style={{ margin: 0, padding: 10, borderRadius: 10, background: "#f8fafc", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            Forbindelser i koden står i <code style={{ fontFamily: MONO }}>server/app/integrations.py</code>. Kald tælles som hændelsen <code style={{ fontFamily: MONO }}>api.call</code> med
            kun endpointets mønster — aldrig adresser, konti eller forespørgsler — og gemmes i 7 dage.
          </p>
        </section>

        <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          {!chosen && !data.loading && <div style={{ ...card, padding: 24, color: "#64748b" }}>Vælg en forbindelse til venstre.</div>}
          {chosen && <Detail c={chosen} period={period} />}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{label}</span>
      <span style={{ fontSize: 24, fontWeight: 700, color: warn ? "#9a3412" : "#020817" }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: warn ? "#9a3412" : "#64748b" }}>{sub}</span>}
    </div>
  );
}

function Group({ title, items, chosen, onChoose, empty }: { title?: string; items: Conn[]; chosen: string | null; onChoose: (c: Conn) => void; empty?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {title && <span style={{ ...sectionLabel, fontSize: 10, padding: "0 8px 6px" }}>{title}</span>}
      {items.length === 0 && empty && <span style={{ fontSize: 12, color: "#64748b", padding: "0 8px" }}>{empty}</span>}
      {items.map((c) => {
        const on = idOf(c) === chosen;
        const st = statusOf(c);
        const keys = c.kind === "code"
          ? (c.secrets.length ? (c.secrets.every((s) => s.set) ? "Miljøvariabel" : "Mangler nøgle") : "Ingen nøgle")
          : (c.secrets.length ? (c.secrets.every((s) => s.ok) ? (c.secrets.some((s) => s.kind === "env") ? "Miljøvariabel" : "Hemmelighed") : "Mangler adgang") : "Ingen nøgle");
        return (
          <button key={idOf(c)} type="button" onClick={() => onChoose(c)} aria-current={on ? "true" : undefined} className={on ? undefined : "tg-hover"}
            style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderRadius: 10, background: on ? "#eff6ff" : "transparent" }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, flex: "none", background: st.tone.dot }} />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 13, fontWeight: on ? 600 : 400, color: on ? "#1d4ed8" : "#020817" }}>{c.name}</span>
              <span style={{ font: `11px ${MONO}`, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.host ?? "ikke sat"}</span>
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <span style={{ fontSize: 12, color: "#334155" }}>{c.counted ? fmt(c.calls) : "—"}</span>
              <span style={{ fontSize: 11, color: keys === "Hemmelighed" ? "#166534" : keys === "Ingen nøgle" ? "#64748b" : "#9a3412" }}>{keys}</span>
            </span>
            <span style={srOnly}>{st.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Detail({ c, period }: { c: Conn; period: string }) {
  const st = statusOf(c);
  return (
    <>
      <div style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{c.name}</h2>
          <span style={{ ...pill(T.gray), display: "inline-flex", alignItems: "center", gap: 6, color: "#334155" }}>
            {c.kind === "code" ? <><Code size={13} aria-hidden />Fra koden</> : <><Plug size={13} aria-hidden />Forbundet i admin</>}
          </span>
          <span style={pill(st.tone)}>{st.label}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {c.kind === "code" && c.link && <Link to={c.link} style={{ fontSize: 13, fontWeight: 500 }}>Åbn i /admin{c.link} →</Link>}
            {c.kind === "source" && <Link to={`/data/connect?source=${c.id}`} style={{ textDecoration: "none" }}><Btn height={32} icon={Plug}>Redigér i Forbind API</Btn></Link>}
          </span>
        </div>
        {c.kind === "code" && (
          <p style={{ margin: 0, fontSize: 14, color: "#475569", lineHeight: 1.55 }}>
            {c.purpose} Kaldes fra {c.files.map((f, i) => <span key={f}>{i ? " og " : ""}<code style={{ fontFamily: MONO, fontSize: 13, color: "#334155" }}>{f}</code></span>)}.
          </p>
        )}
        {c.kind === "source" && (
          <p style={{ margin: 0, fontSize: 14, color: "#475569", lineHeight: 1.55 }}>
            Godkendelse: {AUTH[c.auth ?? ""] ?? "—"}. Serveren må kun kalde {c.hosts.join(" og ") || "—"}; hvert endpoint er et datasæt i kataloget.
          </p>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          <Fact k="Vært" v={c.host ?? "Ikke sat"} mono />
          <Fact k={`Kald ${period}`} v={c.counted ? fmt(c.calls) : "Tælles ikke"} />
          <Fact k="p95" v={c.p95_ms !== null ? `${fmt(c.p95_ms)} ms` : "—"} />
          <Fact k="Sidste fejl" v={c.last_error_at ? fmtDate(c.last_error_at) : "Ingen"} warn={!!c.last_error_at} />
        </div>
      </div>

      <section aria-label="Nøgler" style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
          <span style={sectionLabel}>Nøgler</span>
          <span style={{ fontSize: 13, color: "#64748b" }}>Hvor forbindelsen henter sine hemmeligheder — kun navne, aldrig værdier</span>
        </div>
        {c.secrets.length === 0 && <p style={{ margin: 0, padding: "14px 20px", fontSize: 13, color: "#64748b" }}>Forbindelsen bruger ingen nøgle.</p>}
        {c.kind === "code" && c.secrets.map((s) => (
          <KeyRow key={s.name} name={s.name} ok={s.set} tone={s.set ? T.orange : T.red} badge={s.set ? "Miljøvariabel" : "Ikke sat"}
            text={s.set ? "Sat i app.env · ingen version, ingen ansvarlig og ingen påmindelse om rotation. Forbindelser i koden læser endnu kun miljøvariabler."
              : "Ikke sat på instansen. Forbindelsen virker ikke, før den er sat i app.env."} />
        ))}
        {c.kind === "source" && c.secrets.map((s) => (
          <KeyRow key={s.ref + s.used_as} name={s.ref} ok={s.ok}
            tone={s.kind === "env" ? T.orange : s.ok ? T.green : T.orange}
            badge={s.kind === "env" ? "Miljøvariabel" : s.ok ? "Hemmelighed" : s.pending ? `Afventer ${s.pending.approved} af ${s.pending.total}` : "Ingen adgang"}
            text={`${s.used_as === "auth" ? "Godkendelse" : s.used_as.replace("header:", "Header ")} · ${s.text.startsWith(`${s.ref}: `) ? s.text.slice(s.ref.length + 2) : s.text}${s.grant_expires_at ? ` · til ${fmtDay(s.grant_expires_at)}` : ""}`}
            link={s.secret_id ? `/secrets/${s.secret_id}` : undefined} />
        ))}
        {c.kind === "code" && c.settings.length > 0 && (
          <p style={{ margin: 0, padding: "10px 20px 14px", fontSize: 12, color: "#64748b" }}>
            Indstillinger: {c.settings.map((s, i) => <span key={s.name}>{i ? ", " : ""}<code style={{ fontFamily: MONO }}>{s.name}</code>{s.set ? "" : " (ikke sat)"}</span>)}
          </p>
        )}
      </section>

      <section aria-label="Endpoints" style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
          <span style={sectionLabel}>Endpoints</span>
          <span style={{ fontSize: 13, color: "#64748b" }}>{c.kind === "code" ? "Kendt fra koden og talt i kald" : "Fra kildebeskrivelsen og talt i kald"}</span>
        </div>
        {c.endpoints.length === 0 ? <p style={{ margin: 0, padding: "14px 20px", fontSize: 13, color: "#64748b" }}>
          {c.counted ? "Ingen endpoints." : "Klienten er ikke httpx, så kald registreres ikke endnu."}</p> : (
          <div style={{ overflowX: "auto", position: "relative" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead><tr style={{ background: "#f8fafc" }}>
                <th scope="col" style={{ ...th, paddingLeft: 20 }}>Kald</th>
                <th scope="col" style={th}>{c.kind === "code" ? "Kaldes fra" : "Datasæt"}</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>Kald</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>Fejl</th>
                <th scope="col" style={{ ...th, textAlign: "right", paddingRight: 20 }}>p95</th>
              </tr></thead>
              <tbody>
                {c.endpoints.map((e, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "10px 12px 10px 20px" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                        <span style={{ font: `600 11px ${MONO}`, padding: "2px 6px", borderRadius: 6,
                          background: e.method === "GET" ? "rgba(37,99,235,0.1)" : e.method ? "rgba(249,115,22,0.12)" : "#f1f5f9",
                          color: e.method === "GET" ? "#1d4ed8" : e.method ? "#9a3412" : "#475569" }}>{e.method ?? "ALLE"}</span>
                        <code style={{ fontFamily: MONO, fontSize: 12.5 }}>{e.path}</code>
                      </span>
                      <span style={{ fontSize: 12, color: "#64748b" }}>{e.label}</span>
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      {c.kind === "code" ? <code style={{ fontFamily: MONO, fontSize: 12, color: "#475569" }}>{e.called_from}</code>
                        : e.dataset_id ? <Link to={`/data/explore?d=${e.dataset_id}`}>Udforsk {e.label} →</Link> : <span style={{ color: "#64748b" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>{c.counted ? fmt(e.calls) : "—"}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: e.errors ? "#b91c1c" : "#475569" }}>
                      {e.calls ? fmt(e.errors) : "—"}
                    </td>
                    <td style={{ padding: "10px 20px 10px 12px", textAlign: "right", color: "#475569", whiteSpace: "nowrap" }}>{e.p95_ms !== null ? `${fmt(e.p95_ms)} ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Fact({ k, v, mono, warn }: { k: string; v: string; mono?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{k}</span>
      <span style={{ fontSize: mono ? 13 : 14, fontWeight: mono ? 400 : 600, fontFamily: mono ? MONO : undefined, color: warn ? "#9a3412" : "#020817",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={v}>{v}</span>
    </div>
  );
}

function KeyRow({ name, ok, tone, badge, text, link }: { name: string; ok: boolean; tone: { bg: string; fg: string }; badge: string; text: string; link?: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid #f1f5f9" }}>
      {ok ? <KeyRound size={17} color={tone.fg} aria-hidden /> : <TriangleAlert size={17} color={tone.fg} aria-hidden />}
      <span style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <code style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{name}</code>
        <span style={{ fontSize: 12, color: "#475569" }}>{text}</span>
      </span>
      <span style={pill(tone)}>{badge}</span>
      {link && <Link to={link} style={{ fontSize: 13, fontWeight: 600 }}>Åbn</Link>}
    </div>
  );
}
