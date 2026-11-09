// /admin/nats → NATS. Monitoring of the NATS server in the stack, read through /api/admin/nats (the server's HTTP
// monitoring port, whitelisted endpoints). Tabs: Overblik · Forbindelser · JetStream · Abonnementer · Cluster ·
// Konti · Rå data. ?tab=… is the deep link. Live refresh pauses while the browser tab is hidden.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { RadioTower, RefreshCw } from "lucide-react";
import { api, query } from "../../api";
import { card, fmt, MONO, sectionLabel, select, type Tone } from "../theme";
import { Btn, Empty, ErrorBox, fmtBytes, Json, PageTitle, Pill, Toggle, useLoad } from "../ui";

type Obj = Record<string, any>; // NATS' monitoring JSON varies between versions; every field is read defensively.
type Overview = {
  configured: boolean; monitor_url: string | null; client_url: string | null; reachable: boolean; error: string | null;
  fetched_at: string; endpoints: { key: string; description: string }[];
  varz?: Obj; health?: Obj; jsz?: Obj | null;
};
type EndpointResult = { endpoint: string; http_status: number; fetched_at: string; data: Obj };

type Tab = "overblik" | "forbindelser" | "jetstream" | "abonnementer" | "cluster" | "konti" | "raa";
const TABS: [Tab, string][] = [
  ["overblik", "Overblik"], ["forbindelser", "Forbindelser"], ["jetstream", "JetStream"], ["abonnementer", "Abonnementer"],
  ["cluster", "Cluster"], ["konti", "Konti"], ["raa", "Rå data"],
];
const INTERVALS = [5, 10, 30, 60];
const HISTORY = 60;

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const num = (v: unknown) => fmt(n(v));
const rate = (v: number) => (v >= 100 ? fmt(v) : v.toLocaleString("da-DK", { maximumFractionDigits: 1 }));
const time = (iso: unknown) => (typeof iso === "string" && iso && !iso.startsWith("0001") ? new Date(iso).toLocaleString("da-DK") : "—");
const cardTitle: CSSProperties = { fontSize: 15, fontWeight: 600 };
const muted: CSSProperties = { fontSize: 13, color: "#64748b" };

/** Re-render every `seconds` while live and the browser tab is visible. */
function useTicker(live: boolean, seconds: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [live, seconds]);
  return [tick, () => setTick((t) => t + 1)] as const;
}

export default function Nats() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "overblik") as Tab;
  const [live, setLive] = useState(true);
  const [seconds, setSeconds] = useState(10);
  const [tick, refresh] = useTicker(live, seconds);
  // The overview is fetched on the front tab only (each request is an admin.read line in the audit log).
  const overview = useLoad(() => api.get<Overview>("/api/admin/nats"), [tab === "overblik" ? tick : -1]);
  const o = overview.data;

  const title = (
    <PageTitle title="NATS" icon={<RadioTower size={24} />} aside={o?.configured && (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <Toggle on={live} onChange={() => setLive(!live)} label="Live" deeplink="nats-live" />Live
        </span>
        <select aria-label="Opdater hvert" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} style={{ ...select, height: 32 }}>
          {INTERVALS.map((s) => <option key={s} value={s}>hvert {s}. sek.</option>)}
        </select>
        <Btn icon={RefreshCw} height={32} onClick={refresh}>Opdater</Btn>
      </div>
    )}>
      Beskedserveren i stakken med JetStream på eget volume. Tallene læses fra NATS' overvågningsport gennem appen;
      siden ændrer ikke noget i NATS.
    </PageTitle>
  );

  if (overview.error) return <>{title}<ErrorBox>{overview.error}</ErrorBox></>;
  if (!o) return title;
  if (!o.configured) return <>{title}<NotConfigured /></>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {title}
      <div role="tablist" aria-label="NATS" style={{ display: "flex", gap: 22, borderBottom: "1px solid #e2e8f0", overflowX: "auto" }}>
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} data-deeplink={`nats-tab-${key}`}
            onClick={() => setParams(key === "overblik" ? {} : { tab: key }, { replace: true })}
            style={{ all: "unset", cursor: "pointer", padding: "10px 0", fontSize: 14, whiteSpace: "nowrap", fontWeight: tab === key ? 600 : 500,
              color: tab === key ? "#020817" : "#64748b", borderBottom: tab === key ? "2px solid #2563eb" : "2px solid transparent", marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overblik" && <Overblik o={o} />}
      {tab === "forbindelser" && <Connections tick={tick} />}
      {tab === "jetstream" && <JetStream tick={tick} />}
      {tab === "abonnementer" && <Subscriptions tick={tick} />}
      {tab === "cluster" && <Cluster tick={tick} />}
      {tab === "konti" && <Accounts tick={tick} />}
      {tab === "raa" && <Raw tick={tick} endpoints={o.endpoints} />}
    </div>
  );
}

function NotConfigured() {
  return (
    <div style={{ ...card, padding: 20, display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
      <span style={cardTitle}>NATS er ikke sat op</span>
      <p style={{ margin: 0, ...muted }}>
        Appen kender ikke NATS' overvågningsport. I produktion sætter <code>deploy/compose.yml</code> den selv. Lokalt: start
        NATS med <code>docker compose up -d</code> og sæt i <code>.env</code>:
      </p>
      <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: "#f8fafc", font: `13px ${MONO}` }}>
        NATS_URL=nats://localhost:4222{"\n"}NATS_MONITOR_URL=http://localhost:8222
      </pre>
    </div>
  );
}

// ── Overblik ────────────────────────────────────────────────────────────────

type Sample = { t: number; inMsgs: number; outMsgs: number; inBytes: number; outBytes: number };
type Rates = { inMsgs: number; outMsgs: number; inBytes: number; outBytes: number };

/** Messages and bytes per second from the difference between two varz samples, with a short history. */
function useRates(varz: Obj | undefined) {
  const last = useRef<Sample | null>(null);
  const [history, setHistory] = useState<Rates[]>([]);
  useEffect(() => {
    if (!varz) return;
    const s: Sample = { t: Date.parse(varz.now) || Date.now(), inMsgs: n(varz.in_msgs), outMsgs: n(varz.out_msgs),
      inBytes: n(varz.in_bytes), outBytes: n(varz.out_bytes) };
    const p = last.current;
    last.current = s;
    if (!p || s.t <= p.t || s.inMsgs < p.inMsgs) return; // first sample, or the server restarted
    const dt = (s.t - p.t) / 1000;
    const r = { inMsgs: (s.inMsgs - p.inMsgs) / dt, outMsgs: (s.outMsgs - p.outMsgs) / dt,
      inBytes: (s.inBytes - p.inBytes) / dt, outBytes: (s.outBytes - p.outBytes) / dt };
    setHistory((h) => [...h, r].slice(-HISTORY));
  }, [varz]);
  return history;
}

function healthTone(h: Obj | undefined): [Tone, string] {
  if (!h) return ["gray", "Ukendt"];
  if (h.status === "ok") return ["green", "Sund"];
  return ["red", h.error ? `Usund: ${h.error}` : "Usund"];
}

function Overblik({ o }: { o: Overview }) {
  const v = o.varz;
  const history = useRates(v);
  if (!o.reachable || !v) {
    return (
      <ErrorBox>
        {o.error ?? "NATS svarer ikke."} Overvågning: <span style={{ fontFamily: MONO }}>{o.monitor_url}</span>
      </ErrorBox>
    );
  }
  const [tone, label] = healthTone(o.health);
  const now = history[history.length - 1];
  const js = v.jetstream ?? {};
  const jsCfg = js.config ?? o.jsz?.config ?? {};
  const jsStats = js.stats ?? o.jsz ?? {};
  const jsOn = Boolean(js.config || o.jsz?.config);
  const slow = v.slow_consumer_stats ?? {};

  const kpis: { label: string; value: string; sub: string; deeplink?: string }[] = [
    { label: "Forbindelser", value: num(v.connections), sub: `${num(v.total_connections)} i alt siden start · max ${num(v.max_connections)}` },
    { label: "Abonnementer", value: num(v.subscriptions), sub: `${num(v.slow_consumers)} langsomme forbrugere` },
    { label: "Beskeder ind / ud", value: now ? `${rate(now.inMsgs)} / ${rate(now.outMsgs)}` : "…", sub: `pr. sek. · ${num(v.in_msgs)} / ${num(v.out_msgs)} i alt` },
    { label: "Data ind / ud", value: now ? `${fmtBytes(now.inBytes)} / ${fmtBytes(now.outBytes)}` : "…", sub: `pr. sek. · ${fmtBytes(n(v.in_bytes))} / ${fmtBytes(n(v.out_bytes))} i alt` },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...card, padding: "14px 20px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }} data-deeplink="nats-health">
        <Pill tone={tone}>{label}</Pill>
        <span style={{ fontWeight: 600 }}>{v.server_name || v.server_id}</span>
        <span style={muted}>NATS {v.version} · Go {String(v.go ?? "").replace(/^go/, "")} · oppe {v.uptime ?? "—"} · startet {time(v.start)}</span>
        <span style={{ ...muted, marginLeft: "auto", fontFamily: MONO }}>{o.client_url ?? `${v.host}:${v.port}`}</span>
      </div>

      <div data-deeplink="nats-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={sectionLabel}>{k.label}</span>
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{k.value}</span>
            <span style={{ fontSize: 12, color: "#64748b" }}>{k.sub}</span>
          </div>
        ))}
      </div>

      <div style={{ ...card, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={cardTitle}>Beskeder pr. sekund</span>
          <Legend color="#2563eb">Ind</Legend>
          <Legend color="#f59e0b">Ud</Legend>
          <span style={{ ...muted, marginLeft: "auto", fontSize: 12 }}>Seneste {history.length} målinger, mens siden er åben</span>
        </div>
        {history.length < 2
          ? <span style={muted}>Venter på målinger … (kræver Live eller to opdateringer)</span>
          : <Spark series={[[history.map((h) => h.inMsgs), "#2563eb"], [history.map((h) => h.outMsgs), "#f59e0b"]]} />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        <Panel title="Ressourcer">
          <Row label="Hukommelse">{fmtBytes(n(v.mem))}</Row>
          <Row label="CPU">{rate(n(v.cpu))} % af {num(v.cores)} kerner (GOMAXPROCS {num(v.gomaxprocs)})</Row>
          <Row label="Maks. besked">{fmtBytes(n(v.max_payload))}</Row>
          <Row label="Maks. ventende pr. forbindelse">{fmtBytes(n(v.max_pending))}</Row>
          <Row label="Ping-interval">{fmtDuration(v.ping_interval)} · maks. {num(v.ping_max)} udestående</Row>
          <Row label="Skrive-deadline">{fmtDuration(v.write_deadline)}</Row>
          <Row label="Godkendelse">{v.auth_required ? <Pill tone="green">Token/brugere</Pill> : <Pill tone="orange">Ingen</Pill>} {v.tls_required ? <Pill tone="green">TLS</Pill> : null}</Row>
          <Row label="Konfiguration indlæst">{time(v.config_load_time)}</Row>
        </Panel>

        <Panel title="JetStream" deeplink="nats-jetstream-summary">
          {!jsOn ? <span style={muted}>JetStream er slået fra.</span> : (
            <>
              <Usage label="Disk" used={n(jsStats.storage)} max={n(jsCfg.max_storage)} />
              <Usage label="Hukommelse" used={n(jsStats.memory)} max={n(jsCfg.max_memory)} />
              <Row label="Streams / consumers">{num(o.jsz?.streams)} / {num(o.jsz?.consumers)}</Row>
              <Row label="Beskeder gemt">{num(o.jsz?.messages)} · {fmtBytes(n(o.jsz?.bytes))}</Row>
              <Row label="Konti">{num(jsStats.accounts ?? o.jsz?.accounts)}</Row>
              <Row label="API-kald / fejl">{num(jsStats.api?.total ?? o.jsz?.api?.total)} / {num(jsStats.api?.errors ?? o.jsz?.api?.errors)}</Row>
              <Row label="Lager">{jsCfg.store_dir ? <span style={{ fontFamily: MONO }}>{jsCfg.store_dir}</span> : "—"}</Row>
            </>
          )}
        </Panel>

        <Panel title="Topologi og problemer">
          <Row label="Cluster-ruter">{num(v.routes)}{v.cluster?.name ? ` · ${v.cluster.name}` : ""}</Row>
          <Row label="Gateways (remotes)">{num(v.remotes)}</Row>
          <Row label="Leaf nodes">{num(v.leafnodes)}</Row>
          <Row label="Langsomme forbrugere">
            {num(v.slow_consumers)} (klienter {num(slow.clients)}, ruter {num(slow.routes)}, gateways {num(slow.gateways)}, leafs {num(slow.leafs)})
          </Row>
          <Row label="Forældede forbindelser">{num(v.stale_connections)}</Row>
          <Row label="Systemkonto">{v.system_account ?? "—"}</Row>
          <Row label="Server-id"><span style={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{v.server_id}</span></Row>
        </Panel>
      </div>

      {v.http_req_stats && (
        <Panel title="Kald til overvågningsporten">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(v.http_req_stats as Record<string, number>).filter(([, c]) => c > 0).map(([path, c]) => (
              <span key={path} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#f1f5f9", fontFamily: MONO }}>{path} {fmt(c)}</span>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function fmtDuration(ns: unknown): string {
  if (typeof ns === "string") return ns;
  const v = n(ns);
  if (!v) return "—";
  const s = v / 1e9;
  return s >= 60 ? `${Math.round(s / 60)} min.` : `${rate(s)} sek.`;
}

// ── Forbindelser ────────────────────────────────────────────────────────────

const CONN_SORT: [string, string][] = [
  ["cid", "Id"], ["start", "Startet"], ["subs", "Abonnementer"], ["pending", "Ventende"], ["msgs_to", "Beskeder ud"],
  ["msgs_from", "Beskeder ind"], ["bytes_to", "Data ud"], ["bytes_from", "Data ind"], ["last", "Seneste aktivitet"],
  ["idle", "Inaktiv"], ["uptime", "Oppetid"], ["rtt", "RTT"],
];

function Connections({ tick }: { tick: number }) {
  const [sort, setSort] = useState("cid");
  const [state, setState] = useState("open");
  const [open, setOpen] = useState<number | null>(null);
  const { data, error } = useLoad(
    () => api.get<EndpointResult>(`/api/admin/nats/connz${query({ sort, state, limit: 256, subs: "detail", auth: true })}`),
    [sort, state, tick]);
  const conns: Obj[] = data?.data.connections ?? [];
  const cols = "70px minmax(180px,2fr) 130px 90px 70px 90px 110px 110px 80px";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select aria-label="Tilstand" value={state} onChange={(e) => setState(e.target.value)} style={select}>
          <option value="open">Åbne</option><option value="closed">Lukkede (seneste)</option><option value="any">Alle</option>
        </select>
        <select aria-label="Sortér efter" value={sort} onChange={(e) => setSort(e.target.value)} style={select}>
          {CONN_SORT.map(([k, l]) => <option key={k} value={k}>Sortér: {l}</option>)}
        </select>
        {data && <span style={muted}>{num(data.data.num_connections)} vist af {num(data.data.total)}</span>}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && (conns.length === 0 ? <Empty>Ingen forbindelser.</Empty> : (
        <Table cols={cols} minWidth={980} head={["Id", "Klient", "Adresse", "Sprog", "Abon.", "Ventende", "Beskeder ind/ud", "Data ind/ud", "RTT"]}>
          {conns.map((c) => (
            <Fragment key={c.cid}>
              <button type="button" onClick={() => setOpen(open === c.cid ? null : c.cid)} className="tg-hover" aria-expanded={open === c.cid}
                style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "10px 16px",
                  borderTop: "1px solid #f1f5f9", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ fontFamily: MONO }}>{c.cid}</span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{c.name || <i style={{ color: "#94a3b8" }}>uden navn</i>}</span>
                  <span style={{ fontSize: 11, color: "#64748b" }}>
                    {[c.kind, c.type, c.account, c.authorized_user].filter(Boolean).join(" · ")}{c.reason ? ` · lukket: ${c.reason}` : ""}
                  </span>
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>{c.ip}:{c.port}</span>
                <span>{[c.lang, c.version].filter(Boolean).join(" ") || "—"}</span>
                <span>{num(c.subscriptions)}</span>
                <span style={{ color: n(c.pending_bytes) > 0 ? "#9a3412" : undefined }}>{fmtBytes(n(c.pending_bytes))}</span>
                <span>{num(c.in_msgs)} / {num(c.out_msgs)}</span>
                <span>{fmtBytes(n(c.in_bytes))} / {fmtBytes(n(c.out_bytes))}</span>
                <span>{c.rtt ?? "—"}</span>
              </button>
              {open === c.cid && <ConnectionDetail c={c} />}
            </Fragment>
          ))}
        </Table>
      ))}
    </div>
  );
}

function ConnectionDetail({ c }: { c: Obj }) {
  const subs: Obj[] = c.subscriptions_list_detail ?? (c.subscriptions_list ?? []).map((s: string) => ({ subject: s }));
  return (
    <div style={{ padding: "12px 16px 16px 96px", background: "#f8fafc", borderTop: "1px solid #f1f5f9", display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, fontSize: 13 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Row label="Startet">{time(c.start)}</Row>
        <Row label="Seneste aktivitet">{time(c.last_activity)}</Row>
        <Row label="Oppetid / inaktiv">{c.uptime ?? "—"} / {c.idle ?? "—"}</Row>
        {c.stop && <Row label="Lukket">{time(c.stop)}</Row>}
        <Row label="TLS">{c.tls_version ? `${c.tls_version} ${c.tls_cipher_suite ?? ""}` : "Nej"}</Row>
        {c.jwt && <Row label="JWT">ja</Row>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={sectionLabel}>Abonnementer ({subs.length})</span>
        {subs.length === 0 && <span style={muted}>Ingen.</span>}
        {subs.slice(0, 100).map((s, i) => (
          <span key={`${s.sid ?? i}-${s.subject}`} style={{ fontFamily: MONO, fontSize: 12 }}>
            {s.subject}{s.qgroup ? ` (kø: ${s.qgroup})` : ""}{s.msgs != null ? ` · ${fmt(n(s.msgs))} beskeder` : ""}
          </span>
        ))}
        {subs.length > 100 && <span style={muted}>… og {subs.length - 100} flere</span>}
      </div>
    </div>
  );
}

// ── JetStream ───────────────────────────────────────────────────────────────

function JetStream({ tick }: { tick: number }) {
  const { data, error } = useLoad(
    () => api.get<EndpointResult>(`/api/admin/nats/jsz${query({ accounts: true, streams: true, consumers: true, config: true, limit: 1024 })}`),
    [tick]);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;
  const j = data.data;
  if (j.disabled || !j.config) return <Empty>JetStream er slået fra på serveren.</Empty>;
  const streams: (Obj & { account: string })[] = (j.account_details ?? []).flatMap((a: Obj) =>
    (a.stream_detail ?? []).map((s: Obj) => ({ ...s, account: a.name })));
  const cols = "minmax(160px,1.4fr) minmax(160px,1.6fr) 110px 100px 80px 90px 70px 120px";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        <Panel title="Lager">
          <Usage label="Disk" used={n(j.storage)} max={n(j.config.max_storage)} />
          <Usage label="Hukommelse" used={n(j.memory)} max={n(j.config.max_memory)} />
          <Row label="Reserveret disk / hukommelse">{fmtBytes(n(j.reserved_storage))} / {fmtBytes(n(j.reserved_memory))}</Row>
          <Row label="Mappe"><span style={{ fontFamily: MONO }}>{j.config.store_dir ?? "—"}</span></Row>
        </Panel>
        <Panel title="Indhold">
          <Row label="Streams">{num(j.streams)}</Row>
          <Row label="Consumers">{num(j.consumers)}</Row>
          <Row label="Beskeder">{num(j.messages)} · {fmtBytes(n(j.bytes))}</Row>
          <Row label="Konti">{num(j.accounts)} · HA-aktiver {num(j.ha_assets)}</Row>
          <Row label="API-kald / fejl">{num(j.api?.total)} / {num(j.api?.errors)}{j.api?.inflight != null ? ` · ${num(j.api.inflight)} i gang` : ""}</Row>
        </Panel>
        <Panel title="Meta-cluster">
          {j.meta_cluster ? (
            <>
              <Row label="Navn">{j.meta_cluster.name ?? "—"}</Row>
              <Row label="Leder">{j.meta_cluster.leader ?? "—"}</Row>
              <Row label="Størrelse">{num(j.meta_cluster.cluster_size)}</Row>
              <Row label="Ventende">{num(j.meta_cluster.pending)}</Row>
              {(j.meta_cluster.replicas ?? []).map((r: Obj) => (
                <Row key={r.name} label={r.name}>{r.current ? <Pill tone="green">Ajour</Pill> : <Pill tone="orange">Bagud</Pill>} {r.offline ? <Pill tone="red">Offline</Pill> : null} {r.active ?? ""}</Row>
              ))}
            </>
          ) : <span style={muted}>Én server, ingen cluster.</span>}
        </Panel>
      </div>

      {streams.length === 0 ? <Empty>Ingen streams endnu. Streams, key/value- og object stores oprettes af klienter.</Empty> : (
        <Table cols={cols} minWidth={1000} head={["Stream", "Emner", "Beskeder", "Data", "Consumers", "Lager", "Kopier", "Seneste sekvens"]}>
          {streams.map((s) => {
            const key = `${s.account}/${s.name}`;
            const cfg = s.config ?? {}, st = s.state ?? {};
            const kind = String(s.name).startsWith("KV_") ? "Key/value" : String(s.name).startsWith("OBJ_") ? "Object store" : null;
            return (
              <Fragment key={key}>
                <button type="button" onClick={() => setOpen(open === key ? null : key)} className="tg-hover" aria-expanded={open === key}
                  style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "10px 16px",
                    borderTop: "1px solid #f1f5f9", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontFamily: MONO }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{[kind, s.account, cfg.retention].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{(cfg.subjects ?? []).join(", ") || "—"}</span>
                  <span>{num(st.messages)}</span>
                  <span>{fmtBytes(n(st.bytes))}</span>
                  <span>{num(st.consumer_count)}</span>
                  <span>{cfg.storage ?? "—"}</span>
                  <span>{num(cfg.num_replicas ?? 1)}</span>
                  <span>{num(st.last_seq)}</span>
                </button>
                {open === key && <StreamDetail s={s} />}
              </Fragment>
            );
          })}
        </Table>
      )}
    </div>
  );
}

function limit(v: unknown, unit: (x: number) => string = fmt): string {
  const x = n(v);
  return x <= 0 ? "ingen" : unit(x);
}

function StreamDetail({ s }: { s: Obj }) {
  const cfg = s.config ?? {}, st = s.state ?? {};
  const consumers: Obj[] = s.consumer_detail ?? [];
  const cols = "minmax(140px,1.4fr) 110px 110px 110px 100px 100px minmax(140px,1fr)";
  return (
    <div style={{ padding: "12px 16px 16px 32px", background: "#f8fafc", borderTop: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, fontSize: 13 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Row label="Oprettet">{time(s.created)}</Row>
          <Row label="Første / seneste sekvens">{num(st.first_seq)} / {num(st.last_seq)}</Row>
          <Row label="Første / seneste besked">{time(st.first_ts)} / {time(st.last_ts)}</Row>
          <Row label="Emner med beskeder">{num(st.num_subjects)}</Row>
          <Row label="Slettede">{num(st.num_deleted)}</Row>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Row label="Opbevaring">{cfg.retention ?? "—"} · kassér {cfg.discard ?? "—"}</Row>
          <Row label="Maks. beskeder">{limit(cfg.max_msgs)}</Row>
          <Row label="Maks. data">{limit(cfg.max_bytes, fmtBytes)}</Row>
          <Row label="Maks. alder">{n(cfg.max_age) ? fmtDuration(cfg.max_age) : "ingen"}</Row>
          <Row label="Pr. emne">{limit(cfg.max_msgs_per_subject)}</Row>
          <Row label="Dubletvindue">{fmtDuration(cfg.duplicate_window)}</Row>
        </div>
        {s.cluster && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Row label="Leder">{s.cluster.leader ?? "—"}</Row>
            {(s.cluster.replicas ?? []).map((r: Obj) => (
              <Row key={r.name} label={r.name}>{r.current ? "ajour" : "bagud"}{r.lag ? ` · ${fmt(r.lag)} bagud` : ""}{r.offline ? " · offline" : ""}</Row>
            ))}
          </div>
        )}
      </div>
      {consumers.length === 0 ? <span style={muted}>Ingen consumers.</span> : (
        <Table cols={cols} minWidth={860} head={["Consumer", "Ventende", "Afventer ack", "Genleveret", "Venter (pull)", "Leveret", "Seneste aktivitet"]}>
          {consumers.map((c) => (
            <div key={c.name} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 16px",
              borderTop: "1px solid #f1f5f9", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontWeight: 500 }}>{c.name}</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  {[c.config?.durable_name ? "durable" : "ephemeral", c.config?.ack_policy, c.config?.deliver_subject ? "push" : "pull", c.config?.filter_subject].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span style={{ color: n(c.num_pending) > 1000 ? "#9a3412" : undefined }}>{num(c.num_pending)}</span>
              <span>{num(c.num_ack_pending)}</span>
              <span style={{ color: n(c.num_redelivered) > 0 ? "#9a3412" : undefined }}>{num(c.num_redelivered)}</span>
              <span>{num(c.num_waiting)}</span>
              <span>{num(c.delivered?.stream_seq)}</span>
              <span>{time(c.delivered?.last_active)}</span>
            </div>
          ))}
        </Table>
      )}
    </div>
  );
}

// ── Abonnementer ────────────────────────────────────────────────────────────

function Subscriptions({ tick }: { tick: number }) {
  const [subject, setSubject] = useState("");
  const [test, setTest] = useState("");
  const { data, error } = useLoad(
    () => api.get<EndpointResult>(`/api/admin/nats/subsz${query({ subs: true, limit: 500, test: test || null })}`), [tick, test]);
  const s = data?.data;
  const list: Obj[] = (s?.subscriptions_list ?? []).filter((x: Obj) => !subject || String(x.subject).includes(subject));
  const cols = "minmax(200px,2fr) 140px 120px 90px 110px";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
          <Stat label="Abonnementer" value={num(s.num_subscriptions)} />
          <Stat label="Cache-hitrate" value={`${rate(n(s.cache_hit_rate) * 100)} %`} sub={`${num(s.num_cache)} i cachen`} />
          <Stat label="Opslag" value={num(s.num_matches)} sub={`${num(s.num_inserts)} tilføjet · ${num(s.num_removes)} fjernet`} />
          <Stat label="Fan-out" value={`${rate(n(s.avg_fanout))} gns.`} sub={`maks. ${num(s.max_fanout)}`} />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input aria-label="Filtrér emner" placeholder="Filtrér emne …" value={subject} onChange={(e) => setSubject(e.target.value)}
          style={{ height: 36, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, minWidth: 220 }} />
        <form onSubmit={(e) => { e.preventDefault(); setTest(String(new FormData(e.currentTarget).get("t") ?? "").trim()); }} style={{ display: "flex", gap: 8 }}>
          <input name="t" aria-label="Test et emne" placeholder="Hvem modtager emnet …? (fx orders.new)" defaultValue={test}
            style={{ height: 36, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, minWidth: 260, fontFamily: MONO }} />
          <Btn type="submit">Test</Btn>
          {test && <Btn kind="ghost" onClick={() => setTest("")}>Nulstil</Btn>}
        </form>
      </div>
      {test && <span style={muted}>Viser abonnementer, der modtager <span style={{ fontFamily: MONO }}>{test}</span>.</span>}
      {s && (list.length === 0 ? <Empty>Ingen abonnementer.</Empty> : (
        <Table cols={cols} minWidth={640} head={["Emne", "Kø-gruppe", "Konto", "Forbindelse", "Beskeder"]}>
          {list.map((x, i) => (
            <div key={`${x.cid}-${x.sid}-${i}`} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, padding: "8px 16px", borderTop: "1px solid #f1f5f9",
              fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis" }}>{x.subject}</span>
              <span>{x.qgroup || "—"}</span>
              <span>{x.account ?? "—"}</span>
              <span style={{ fontFamily: MONO }}>{x.cid ?? "—"}</span>
              <span>{num(x.msgs)}</span>
            </div>
          ))}
        </Table>
      ))}
      {s && n(s.total) > list.length && !subject && <span style={muted}>Viser {list.length} af {num(s.total)}.</span>}
    </div>
  );
}

// ── Cluster ─────────────────────────────────────────────────────────────────

function Cluster({ tick }: { tick: number }) {
  const routes = useLoad(() => api.get<EndpointResult>("/api/admin/nats/routez"), [tick]);
  const gateways = useLoad(() => api.get<EndpointResult>("/api/admin/nats/gatewayz"), [tick]);
  const leafs = useLoad(() => api.get<EndpointResult>("/api/admin/nats/leafz"), [tick]);
  const cols = "minmax(180px,2fr) 150px 90px 80px 130px 130px";
  const peerRow = (key: string, name: ReactNode, sub: string, p: Obj) => (
    <div key={key} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 16px", borderTop: "1px solid #f1f5f9",
      fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{name}</span><span style={{ fontSize: 11, color: "#64748b" }}>{sub}</span>
      </span>
      <span style={{ fontFamily: MONO, fontSize: 12 }}>{p.ip ? `${p.ip}:${p.port}` : "—"}</span>
      <span>{p.rtt ?? "—"}</span>
      <span>{num(p.subscriptions)}</span>
      <span>{num(p.in_msgs)} / {num(p.out_msgs)}</span>
      <span>{fmtBytes(n(p.in_bytes))} / {fmtBytes(n(p.out_bytes))}</span>
    </div>
  );
  const head = ["Navn", "Adresse", "RTT", "Abon.", "Beskeder ind/ud", "Data ind/ud"];
  const r: Obj[] = routes.data?.data.routes ?? [];
  const l: Obj[] = leafs.data?.data.leafs ?? [];
  const gw = gateways.data?.data ?? {};
  const outbound = Object.entries((gw.outbound_gateways ?? {}) as Record<string, Obj>);
  const inbound = Object.entries((gw.inbound_gateways ?? {}) as Record<string, Obj[]>).flatMap(([name, list]) => (list ?? []).map((g, i) => [name, g, i] as const));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {[routes.error, gateways.error, leafs.error].filter(Boolean).map((e) => <ErrorBox key={e}>{e}</ErrorBox>)}
      <Section title={`Cluster-ruter (${r.length})`}>
        {r.length === 0 ? <Empty>Ingen ruter. NATS kører som én server.</Empty> : (
          <Table cols={cols} minWidth={760} head={head}>
            {r.map((x) => peerRow(String(x.rid), x.remote_name || x.remote_id, `${x.did_solicit ? "udgående" : "indgående"}${x.is_configured ? " · konfigureret" : ""}`, x))}
          </Table>
        )}
      </Section>
      <Section title={`Gateways${gw.name ? ` · ${gw.name}` : ""} (${outbound.length + inbound.length})`}>
        {outbound.length + inbound.length === 0 ? <Empty>Ingen gateways.</Empty> : (
          <Table cols={cols} minWidth={760} head={head}>
            {outbound.map(([name, g]) => peerRow(`out-${name}`, name, `udgående${g.configured ? " · konfigureret" : ""}`, g.connection ?? {}))}
            {inbound.map(([name, g, i]) => peerRow(`in-${name}-${i}`, name, "indgående", g.connection ?? {}))}
          </Table>
        )}
      </Section>
      <Section title={`Leaf nodes (${l.length})`}>
        {l.length === 0 ? <Empty>Ingen leaf nodes.</Empty> : (
          <Table cols={cols} minWidth={760} head={head}>
            {l.map((x, i) => peerRow(`${x.name}-${i}`, x.name || "—", [x.account, x.is_spoke ? "spoke" : "hub"].filter(Boolean).join(" · "), x))}
          </Table>
        )}
      </Section>
    </div>
  );
}

// ── Konti ───────────────────────────────────────────────────────────────────

function Accounts({ tick }: { tick: number }) {
  const { data, error } = useLoad(() => api.get<EndpointResult>("/api/admin/nats/accstatz?unused=true"), [tick]);
  const accounts = useLoad(() => api.get<EndpointResult>("/api/admin/nats/accountz"), []);
  const [pick, setPick] = useState<string | null>(null);
  const detail = useLoad(() => (pick ? api.get<EndpointResult>(`/api/admin/nats/accountz${query({ acc: pick })}`) : Promise.resolve(null)), [pick]);
  const list: Obj[] = data?.data.account_statz ?? [];
  const system = accounts.data?.data.system_account;
  const cols = "minmax(160px,2fr) 100px 80px 90px 150px 150px 90px";
  const msgs = (x: Obj | undefined) => n(x?.msgs ?? x?.messages);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && (list.length === 0 ? <Empty>Ingen konti.</Empty> : (
        <Table cols={cols} minWidth={860} head={["Konto", "Forbindelser", "Leafs", "Abon.", "Sendt", "Modtaget", "Langsomme"]}>
          {list.map((a) => (
            <button key={a.acc} type="button" onClick={() => setPick(pick === a.acc ? null : a.acc)} className="tg-hover"
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "10px 16px",
                borderTop: "1px solid #f1f5f9", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ fontFamily: MONO, fontWeight: 500 }}>{a.acc}{a.acc === system ? <Pill tone="gray" style={{ marginLeft: 8 }}>system</Pill> : null}</span>
              <span>{num(a.conns)} / {num(a.total_conns)}</span>
              <span>{num(a.leafnodes)}</span>
              <span>{num(a.num_subscriptions)}</span>
              <span>{fmt(msgs(a.sent))} · {fmtBytes(n(a.sent?.bytes))}</span>
              <span>{fmt(msgs(a.received))} · {fmtBytes(n(a.received?.bytes))}</span>
              <span>{num(a.slow_consumers)}</span>
            </button>
          ))}
        </Table>
      ))}
      {pick && (
        <Panel title={`Konto ${pick}`}>
          {detail.error && <ErrorBox>{detail.error}</ErrorBox>}
          {detail.data && <Json value={detail.data.data.account_detail ?? detail.data.data} />}
        </Panel>
      )}
    </div>
  );
}

// ── Rå data ─────────────────────────────────────────────────────────────────

function Raw({ tick, endpoints }: { tick: number; endpoints: Overview["endpoints"] }) {
  const [endpoint, setEndpoint] = useState("varz");
  const { data, error } = useLoad(() => api.get<EndpointResult>(`/api/admin/nats/${endpoint}`), [endpoint, tick]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select aria-label="Endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} style={select}>
          {endpoints.map((e) => <option key={e.key} value={e.key}>/{e.key} — {e.description}</option>)}
        </select>
        {data && <span style={muted}>HTTP {data.http_status} · hentet {new Date(data.fetched_at).toLocaleTimeString("da-DK")}</span>}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && <Json value={data.data} />}
    </div>
  );
}

// ── Small parts ─────────────────────────────────────────────────────────────

function Panel({ title, deeplink, children }: { title: string; deeplink?: string; children: ReactNode }) {
  return (
    <div data-deeplink={deeplink} style={{ ...card, padding: 20, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <span style={cardTitle}>{title}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><span style={sectionLabel}>{title}</span>{children}</div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 13, alignItems: "baseline" }}>
      <span style={{ color: "#64748b", flex: "none" }}>{label}</span>
      <span style={{ marginLeft: "auto", textAlign: "right", fontVariantNumeric: "tabular-nums", minWidth: 0 }}>{children}</span>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={sectionLabel}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "#64748b" }}>{sub}</span>}
    </div>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const color = pct > 90 ? "#dc2626" : pct > 75 ? "#f59e0b" : "#16a34a";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", fontSize: 13 }}>
        <span style={{ color: "#64748b" }}>{label}</span>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
          {fmtBytes(used)} af {max > 0 ? fmtBytes(max) : "ubegrænset"}{max > 0 ? ` · ${rate(pct)} %` : ""}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 9999, background: "#f1f5f9", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 9999 }} />
      </div>
    </div>
  );
}

function Table({ cols, head, minWidth, children }: { cols: string; head: string[]; minWidth: number; children: ReactNode }) {
  return (
    <div style={{ ...card, overflowX: "auto" }}>
      <div style={{ minWidth }}>
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid #e2e8f0",
          fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b" }}>
          {head.map((h) => <span key={h}>{h}</span>)}
        </div>
        {children}
      </div>
    </div>
  );
}

function Legend({ color, children }: { color: string; children: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#64748b" }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />{children}
    </span>
  );
}

/** Line chart of a few series over the same samples. */
function Spark({ series }: { series: [number[], string][] }) {
  const W = 600, H = 120;
  const max = Math.max(1, ...series.flatMap(([v]) => v));
  const len = Math.max(...series.map(([v]) => v.length));
  const x = (i: number) => (len <= 1 ? 0 : (i / (len - 1)) * W);
  const y = (v: number) => H - 4 - (v / max) * (H - 8);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }} role="img"
        aria-label={`Beskeder pr. sekund, højst ${rate(max)}`}>
        <line x1={0} x2={W} y1={H - 4} y2={H - 4} stroke="#e2e8f0" />
        {series.map(([values, color]) => (
          <polyline key={color} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
            points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
        <span>maks. {rate(max)}/s</span><span>Nu</span>
      </div>
    </div>
  );
}
