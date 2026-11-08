// /admin/mcp → MCP-servere (ToerGaer Admin.dc.html, section "mcp"). Server switch Appen / Admin and tabs Oversigt ·
// Værktøjer · Kladder · Monitor · Forbind. Tools run through /api/admin/mcp exactly as over MCP and are logged in
// mcp_log; draft tools return a draft that is confirmed or cancelled here. ?server=app|admin&tab=… is the deep link.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlugZap } from "lucide-react";
import { api, errorText } from "../../api";
import { useAdmin } from "../context";
import { card, MONO, SANS } from "../theme";
import { copyText, ErrorBox, PageTitle, useLoad, useToast } from "../ui";

type Server = "app" | "admin";
type Tab = "overview" | "tools" | "drafts" | "monitor" | "connect";
type Mode = "read" | "write" | "draft" | "confirm";
type Param = { name: string; type: string; desc: string; optional?: boolean };
type Tool = { name: string; domain: string; mode: Mode; description: string; params: Param[];
  link?: { section: string; args?: string[]; focus?: string; label: string } };
type ServerInfo = { id: Server; label: string; path: string; scope: string; who: string; name: string; tenant: string; writes: string };
type Catalog = { server: ServerInfo; origin: string; domains: Record<string, { label: string; src: string[] }>;
  prompts: { server: Server; q: string; tools: string[] }[]; tools: Tool[] };
type Overview = { enabled: boolean; endpoint: string; clients: { id: string; name: string; sessions: number }[];
  stats30d: { calls: number; errors: number; callers: number }; draftTtlMinutes: number };
type Draft = { draftId: string; server: Server; tool: string; args: Record<string, unknown>; summary: string;
  impact: { bullets?: string[]; warnings?: string[] }; status: string; statusText: string; createdAt: string; expiresAt: string };
type Event = { id: number; ts: string; server: Server; method: string; tool: string | null; status: string; duration_ms: number | null;
  client: string | null; user_name: string | null };

const TABS: [Tab, string][] = [["overview", "Oversigt"], ["tools", "Værktøjer"], ["drafts", "Kladder"], ["monitor", "Monitor"], ["connect", "Forbind"]];
const MODE: Record<Mode, [string, string, string]> = {
  read: ["Læs", "#dcfce7", "#166534"], write: ["Skriver", "#dbeafe", "#1e40af"],
  draft: ["Kladde → bekræft", "#fef3c7", "#92400e"], confirm: ["Bekræfter", "#fee2e2", "#991b1b"],
};
const STATUS: Record<string, [string, string]> = {
  ok: ["#dcfce7", "#166534"], error: ["#fee2e2", "#991b1b"], forbidden: ["#fee2e2", "#991b1b"], auth_failed: ["#fee2e2", "#991b1b"],
  draft: ["#fef3c7", "#92400e"], confirmed: ["#dbeafe", "#1e40af"], pending: ["#fef3c7", "#92400e"],
  cancelled: ["#f1f5f9", "#475569"], expired: ["#f1f5f9", "#475569"], failed: ["#fee2e2", "#991b1b"],
};
const HERO: Record<Server, [string, string]> = {
  app: ["Dine klip og filer i Claude, Copilot og ChatGPT",
    "Brugeren logger ind med telefonnummer og kode som i appen. Serveren ser kun brugerens egne data. Sletning og GDPR-eksport kræver en bekræftet kladde."],
  admin: ["Administrér hele instansen fra én chat",
    "Statistik, brugere og roller, efterligning, features og ringe, logs, GDPR og en læse-database. Læsning svarer med det samme. Ændringer kommer tilbage som en kladde, som du bekræfter."],
};
const CONNECT_INTRO: Record<Server, string> = {
  app: "Klienten åbner Gær-login første gang: telefonnummer, kode og passkey. Bagefter står klienten under Konto → Aktive logins, hvor den kan fjernes.",
  admin: "Klienten åbner Gær-login første gang. Kun brugere med admin-rollen kan godkende scope mcp:admin, og rollen tjekkes igen ved hvert kald.",
};

const pill = (bg: string, fg: string) => ({ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 9999, background: bg, color: fg, whiteSpace: "nowrap" as const });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function linkUrl(origin: string, t: Tool, args: Record<string, string>): string {
  if (!t.link) return "";
  const fill = (x: string) => x.replace(/\{(\w+)\}/g, (_, k: string) => args[k] || `{${k}}`);
  const path = fill(t.link.section);
  const q = new URLSearchParams({ path });
  (t.link.args ?? []).forEach((k) => q.set(k, args[k] || `{${k}}`));
  if (t.link.focus) q.set("focus", fill(t.link.focus));
  return origin + (path.startsWith("/admin") ? "/admin/go?" : "/go?") + q.toString().replace(/%7B/g, "{").replace(/%7D/g, "}").replace(/%2F/g, "/");
}

export default function Mcp() {
  const [params, setParams] = useSearchParams();
  const server: Server = params.get("server") === "app" ? "app" : "admin";
  const tab: Tab = (TABS.find(([k]) => k === params.get("tab"))?.[0]) ?? "overview";
  const go = (next: { server?: Server; tab?: Tab }) => {
    const q = new URLSearchParams(params);
    if (next.server) q.set("server", next.server);
    if (next.tab) q.set("tab", next.tab);
    q.delete("focus");
    setParams(q, { replace: true });
  };

  const { refreshDrafts } = useAdmin();
  const say = useToast();
  const catalog = useLoad(() => api.get<Catalog>(`/api/admin/mcp/tools?server=${server}`), [server]);
  const overview = useLoad(() => api.get<Overview>(`/api/admin/mcp/overview?server=${server}`), [server]);
  const drafts = useLoad(() => api.get<{ drafts: Draft[] }>("/api/admin/mcp/drafts"), []);
  const allDrafts = drafts.data?.drafts ?? [];
  const pending = allDrafts.filter((d) => d.status === "pending").length;

  // Tools tab
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"all" | Mode>("all");
  const [domain, setDomain] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ text: string; ms: number; error: boolean } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const cat = catalog.data;
  const tools = cat?.tools ?? [];
  const domains = useMemo(() => [...new Set(tools.map((t) => t.domain))], [tools]);
  const ql = q.trim().toLowerCase();
  const shown = tools.filter((t) => (mode === "all" || t.mode === mode || (mode === "draft" && t.mode === "confirm"))
    && (!domain || t.domain === domain) && (!ql || `${t.name} ${t.description} ${t.domain}`.toLowerCase().includes(ql)));
  const tool = tools.find((t) => t.name === sel);
  const draft = allDrafts.find((d) => d.draftId === active);

  const copy = (key: string, value: string) => {
    copyText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1500);
  };
  const pick = (name: string, withArgs: Record<string, string> = {}) => {
    setSel(name); setArgs(withArgs); setResult(null); setActive(null); setReason("");
    go({ tab: "tools" });
  };
  const reloadDrafts = async () => { await Promise.all([drafts.reload(), refreshDrafts()]); };

  const run = async () => {
    if (!tool) return;
    setBusy(true);
    try {
      const r = await api.post<{ result: Record<string, unknown>; isError: boolean; ms: number }>(
        `/api/admin/mcp/tools/${tool.name}/invoke?server=${server}`, { args });
      if (!r.isError && (tool.mode === "draft") && typeof r.result.draftId === "string") {
        setResult(null);
        setActive(r.result.draftId);
        setReason("");
        await reloadDrafts();
      } else {
        setActive(null);
        setResult({ text: JSON.stringify(r.result, null, 2), ms: r.ms, error: r.isError });
      }
    } catch (e) {
      say(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (d: Draft, confirm: boolean) => {
    setBusy(true);
    try {
      if (confirm) {
        await api.post(`/api/admin/mcp/drafts/${d.draftId}/confirm`, { reason: reason.trim() });
        say(`Kladde ${d.draftId} er bekræftet og udført`);
      } else {
        await api.post(`/api/admin/mcp/drafts/${d.draftId}/cancel`);
        say(`Kladde ${d.draftId} er annulleret`);
      }
    } catch (e) {
      say(errorText(e));
    } finally {
      setBusy(false);
      await reloadDrafts();
    }
  };

  const srv = cat?.server;
  const origin = cat?.origin ?? window.location.origin;
  const ov = overview.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageTitle title="MCP-servere" icon={<PlugZap size={24} color="#f59e0b" strokeWidth={2} />}
        aside={
          <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 9999, background: "#e2e8f0" }}>
            {([["app", "Appen", "/mcp"], ["admin", "Admin", "/mcp/admin"]] as [Server, string, string][]).map(([k, l, p]) => (
              <button key={k} onClick={() => { setSel(null); setDomain(""); setResult(null); setActive(null); go({ server: k }); }} style={{ border: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                padding: "6px 14px", borderRadius: 9999, font: `500 13px ${SANS}`, background: server === k ? "#ffffff" : "transparent",
                color: server === k ? "#020817" : "#64748b", boxShadow: server === k ? "0 1px 2px rgba(2,8,23,0.08)" : "none" }}>
                {l}<span style={{ font: `11px ${MONO}`, color: "#64748b" }}>{p}</span>
              </button>
            ))}
          </div>
        }>
        To servere i containeren. Appen arbejder som den bruger, der loggede ind, med egne data. Admin kan alt i /admin, og hver ændring kommer
        tilbage som en kladde, du bekræfter.
      </PageTitle>

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e2e8f0", overflowX: "auto" }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => go({ tab: k })} style={{ marginBottom: -1, border: 0, borderBottom: `2px solid ${tab === k ? "#2563eb" : "transparent"}`,
            background: "transparent", cursor: "pointer", padding: "10px 12px", whiteSpace: "nowrap",
            font: `${tab === k ? 600 : 500} 14px ${SANS}`, color: tab === k ? "#020817" : "#64748b" }}>
            {k === "drafts" && pending ? `${l} · ${pending}` : l}
          </button>
        ))}
      </div>

      {(catalog.error || overview.error) && <ErrorBox>{catalog.error || overview.error}</ErrorBox>}
      {!cat && !catalog.error && (
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b" }}>Henter værktøjskatalog …</div>
      )}

      {cat && srv && tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {ov && !ov.enabled && (
            <ErrorBox>{srv.label}-serveren er slået fra ({server === "app" ? "MCP_APP_ENABLED" : "MCP_ADMIN_ENABLED"}=0). Klienter får 404.</ErrorBox>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 20, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <span style={{ alignSelf: "flex-start", padding: "3px 10px", borderRadius: 9999, background: "#eff6ff", color: "#1e58d3", font: `600 12px ${MONO}` }}>
                {new URL(origin).host}{srv.path}
              </span>
              <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.15, letterSpacing: "-0.025em", fontWeight: 700, textWrap: "balance" }}>{HERO[server][0]}</h2>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "#64748b", maxWidth: 600, textWrap: "pretty" }}>{HERO[server][1]}</p>
            </div>
            <div style={{ position: "relative", isolation: "isolate" }}>
              <div style={{ position: "absolute", inset: -4, borderRadius: 20, background: "linear-gradient(90deg,#f97316,#f59e0b)", filter: "blur(12px)", opacity: 0.22, zIndex: -1 }} />
              <div style={{ background: "#ffffff", border: "1px solid rgba(37,99,235,0.2)", borderRadius: 16, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
                <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", color: "#64748b" }}>FORBINDELSE</span>
                <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", gap: "8px 12px", fontSize: 13 }}>
                  {([["Endpoint", ov?.endpoint ?? origin + srv.path, MONO], ["Login", `OAuth 2.0 PKCE · Gær-login · scope ${srv.scope}`, "inherit"],
                    ["Hvem", srv.who, "inherit"], ["Data", srv.tenant, "inherit"], ["Skrivninger", srv.writes, "inherit"],
                    ["Klienter", ov?.clients.length ? ov.clients.map((c) => `${c.name} (${c.sessions})`).join(", ") : "Ingen forbundne endnu", "inherit"]] as [string, string, string][])
                    .map(([k, v, font]) => [
                      <span key={k} style={{ color: "#64748b" }}>{k}</span>,
                      <span key={k + "v"} style={{ fontFamily: font, overflowWrap: "anywhere" }}>{v}</span>,
                    ])}
                </div>
                <button onClick={() => go({ tab: "connect" })} style={{ alignSelf: "flex-start", height: 36, padding: "0 14px", borderRadius: 8, border: 0,
                  cursor: "pointer", background: "#2563eb", color: "#f8fafc", font: `500 13px ${SANS}` }}>Se opsætning af klienter</button>
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
            {([["Værktøjer", tools.length], ["Læs", tools.filter((t) => t.mode === "read").length],
              [server === "app" ? "Skriver og kladder" : "Kladder", tools.filter((t) => t.mode !== "read").length],
              ["Med deep link", tools.filter((t) => t.link).length], ["Kald · 30 dage", ov?.stats30d.calls ?? 0],
              ["Fejl · 30 dage", ov?.stats30d.errors ?? 0], ["Brugere · 30 dage", ov?.stats30d.callers ?? 0]] as [string, number][]).map(([l, v]) => (
              <div key={l} style={{ ...card, padding: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, color: "#64748b" }}>{l}</span>
                <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Prøv at spørge</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
              {cat.prompts.map((p) => (
                <div key={p.q} style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, textWrap: "pretty" }}>„{p.q}“</span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {p.tools.map((n) => (
                      <button key={n} onClick={() => pick(n)} style={{ border: 0, cursor: "pointer", padding: "2px 8px", borderRadius: 6, background: "#f1f5f9",
                        color: "#334155", font: `12px ${MONO}` }}>{n}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Domæner</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
              {domains.map((d) => (
                <button key={d} onClick={() => { setDomain(d); go({ tab: "tools" }); }} style={{ textAlign: "left", cursor: "pointer",
                  background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#020817" }}>{cat.domains[d]?.label ?? d}</span>
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748b" }}>{tools.filter((t) => t.domain === d).length} værktøjer</span>
                  </span>
                  <span style={{ font: `11px ${MONO}`, color: "#64748b", overflowWrap: "anywhere" }}>{cat.domains[d]?.src.join(" · ")}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {cat && tab === "tools" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søg i værktøjer, beskrivelser og domæner"
                style={{ height: 36, padding: "0 12px", border: "1px solid #e2e8f0", borderRadius: 8, font: `14px ${SANS}` }} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {([["all", "Alle"], ["read", "Læs"], ...(server === "app" ? [["write", "Skriver"]] : []), ["draft", "Kladde → bekræft"]] as ["all" | Mode, string][]).map(([k, l]) => (
                  <button key={k} onClick={() => setMode(k)} style={{ border: 0, cursor: "pointer", padding: "4px 10px", borderRadius: 9999, font: `500 12px ${SANS}`,
                    background: mode === k ? "#0f172a" : "#f1f5f9", color: mode === k ? "#ffffff" : "#334155" }}>{l}</button>
                ))}
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748b" }}>{shown.length} af {tools.length}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[["", "Alle domæner"], ...domains.map((d) => [d, cat.domains[d]?.label ?? d])].map(([k, l]) => (
                  <button key={k} onClick={() => setDomain(k)} style={{ border: 0, cursor: "pointer", padding: "3px 10px", borderRadius: 6, font: `500 12px ${SANS}`,
                    background: domain === k ? "#2563eb" : "#f1f5f9", color: domain === k ? "#ffffff" : "#334155" }}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{ ...card, overflow: "hidden" }}>
              {shown.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#64748b", fontSize: 13 }}>Ingen værktøjer matcher filteret.</div>}
              {shown.map((t) => (
                <button key={t.name} onClick={() => pick(t.name)} className="tg-hover" style={{ width: "100%", textAlign: "left", cursor: "pointer", border: 0,
                  borderBottom: "1px solid #f1f5f9", background: sel === t.name ? "#eff6ff" : "#ffffff", padding: "11px 18px", display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ font: `600 13px ${MONO}`, color: "#020817" }}>{t.name}</span>
                    <span style={pill(MODE[t.mode][1], MODE[t.mode][2])}>{MODE[t.mode][0]}</span>
                    {t.link && <span style={pill("#eff6ff", "#1e58d3")}>Deep link</span>}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8" }}>{cat.domains[t.domain]?.label ?? t.domain}</span>
                  </span>
                  <span style={{ fontSize: 13, color: "#64748b", textWrap: "pretty" }}>{t.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ position: "sticky", top: 72, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            {!tool && (
              <div style={{ border: "1px dashed #cbd5e1", borderRadius: 16, padding: 22, display: "flex", flexDirection: "column", gap: 6, color: "#64748b", fontSize: 13 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#334155" }}>Inspektør</span>
                <span style={{ textWrap: "pretty" }}>
                  Vælg et værktøj for at se parametre og køre det. Læseværktøjer svarer med det samme. Kladdeværktøjer giver en kladde, som du bekræfter her
                  eller med confirm_draft.
                </span>
              </div>
            )}
            {tool && (
              <div style={{ background: "#ffffff", border: "1px solid rgba(37,99,235,0.2)", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ font: `600 16px ${MONO}` }}>{tool.name}</span>
                  <span style={pill(MODE[tool.mode][1], MODE[tool.mode][2])}>{MODE[tool.mode][0]}</span>
                </div>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "#334155", textWrap: "pretty" }}>{tool.description}</p>
                <span style={{ font: `11px ${MONO}`, color: "#64748b" }}>
                  {cat.domains[tool.domain]?.label} · {cat.domains[tool.domain]?.src.join(" · ")}
                </span>
                {tool.params.length === 0 && <span style={{ fontSize: 13, color: "#64748b" }}>Ingen parametre.</span>}
                {tool.params.map((p) => (
                  <label key={p.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ font: `12px ${MONO}`, color: "#334155" }}>{p.name} · {p.type}{p.optional ? " (valgfri)" : ""}</span>
                    <input value={args[p.name] ?? ""} placeholder={p.desc} onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })}
                      style={{ height: 34, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: `13px ${MONO}` }} />
                  </label>
                ))}
                {tool.link && (
                  <div style={{ background: "#eff6ff", border: "1px solid rgba(37,99,235,0.2)", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#1e58d3" }}>DEEP LINK · {tool.link.label}</span>
                      <button onClick={() => copy("link", linkUrl(origin, tool, args))} style={{ marginLeft: "auto", height: 26, padding: "0 10px", borderRadius: 6,
                        border: "1px solid rgba(37,99,235,0.3)", background: "#ffffff", cursor: "pointer", font: `500 12px ${SANS}`, color: "#1e58d3" }}>
                        {copied === "link" ? "Kopieret" : "Kopiér link"}
                      </button>
                    </div>
                    <span style={{ font: `12px ${MONO}`, color: "#020817", overflowWrap: "anywhere" }}>{linkUrl(origin, tool, args)}</span>
                    {tool.link.focus && (
                      <span style={{ alignSelf: "flex-start", padding: "1px 8px", borderRadius: 6, background: "#ffffff", font: `11px ${MONO}`, color: "#334155" }}>
                        focus {tool.link.focus.replace(/\{(\w+)\}/g, (_, k: string) => args[k] || `{${k}}`)}
                      </span>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={run} disabled={busy} style={{ height: 36, padding: "0 16px", borderRadius: 8, border: 0, cursor: "pointer", background: "#2563eb",
                    color: "#f8fafc", font: `500 13px ${SANS}`, opacity: busy ? 0.6 : 1 }}>{tool.mode === "draft" ? "Opret kladde" : "Kør"}</button>
                  <button onClick={() => { setSel(null); setResult(null); setActive(null); }} style={{ height: 36, padding: "0 14px", borderRadius: 8,
                    border: "1px solid #e2e8f0", cursor: "pointer", background: "#ffffff", color: "#020817", font: `500 13px ${SANS}` }}>Luk</button>
                </div>
              </div>
            )}
            {tool && result && !draft && (
              <div style={{ background: "#0f172a", borderRadius: 16, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", fontSize: 12, color: "#94a3b8" }}>
                  <span style={{ fontWeight: 600, color: result.error ? "#fca5a5" : "#e2e8f0" }}>{result.error ? "Fejl" : "Resultat"}</span>
                  <span style={{ marginLeft: "auto" }}>{result.ms} ms</span>
                </div>
                <pre style={{ margin: 0, font: `12px/1.5 ${MONO}`, color: "#e2e8f0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto" }}>
                  {result.text}
                </pre>
              </div>
            )}
            {draft && <DraftCard draft={draft} reason={reason} setReason={setReason} busy={busy} decide={decide} />}
          </div>
        </div>
      )}

      {tab === "drafts" && (
        <div data-deeplink="mcp-drafts" style={{ ...card, overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#64748b" }}>
            Afventende kladder udløber efter {ov?.draftTtlMinutes ?? 10} minutter. Kun den, der oprettede en kladde, kan bekræfte den. Her ser du dine egne
            kladder fra begge servere, også dem en MCP-klient har lavet.
          </div>
          {drafts.error && <div style={{ padding: 18 }}><ErrorBox>{drafts.error}</ErrorBox></div>}
          {allDrafts.length === 0 && !drafts.loading && (
            <div style={{ padding: 28, textAlign: "center", color: "#64748b", fontSize: 13 }}>Ingen kladder endnu. Kør et kladdeværktøj under Værktøjer.</div>
          )}
          {allDrafts.map((d) => (
            <div key={d.draftId} style={{ display: "grid", gridTemplateColumns: "minmax(180px,1fr) minmax(200px,2fr) 110px 90px", gap: 12, alignItems: "center",
              padding: "11px 18px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ font: `600 13px ${MONO}` }}>{d.tool}</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>{d.draftId} · {fmtTime(d.createdAt)} · {d.server === "app" ? "/mcp" : "/mcp/admin"}</span>
              </span>
              <span style={{ color: "#334155", textWrap: "pretty" }}>{d.summary}</span>
              <span><span style={pill(...(STATUS[d.status] ?? STATUS.ok))}>{d.statusText}</span></span>
              <span>
                {d.status === "pending" && (
                  <button onClick={() => {
                    go({ server: d.server, tab: "tools" });
                    setSel(d.tool);
                    setArgs(Object.fromEntries(Object.entries(d.args).map(([k, v]) => [k, String(v)])));
                    setResult(null);
                    setActive(d.draftId);
                    setReason("");
                  }} style={{ height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#ffffff", cursor: "pointer",
                    font: `500 12px ${SANS}`, color: "#020817" }}>Gennemgå</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "monitor" && <Monitor server={server} />}

      {tab === "connect" && srv && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 900 }}>
          <p style={{ margin: 0, fontSize: 14, color: "#475569", lineHeight: 1.55, textWrap: "pretty" }}>{CONNECT_INTRO[server]}</p>
          {clientSnippets(srv, origin).map(([title, code], i) => (
            <div key={title} style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
                <button onClick={() => copy(`c${i}`, code)} style={{ marginLeft: "auto", height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid #e2e8f0",
                  background: "#ffffff", cursor: "pointer", font: `500 12px ${SANS}`, color: "#020817" }}>{copied === `c${i}` ? "Kopieret" : "Kopiér"}</button>
              </div>
              <pre style={{ margin: 0, padding: "12px 14px", borderRadius: 10, background: "#0f172a", color: "#e2e8f0", font: `12px/1.55 ${MONO}`,
                whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function clientSnippets(srv: ServerInfo, origin: string): [string, string][] {
  const url = origin + srv.path;
  return [
    ["Claude Code", `claude mcp add --transport http ${srv.name} ${url}`],
    ["Claude Desktop", `{\n  "mcpServers": {\n    "${srv.name}": { "command": "npx", "args": ["mcp-remote", "${url}"] }\n  }\n}`],
    ["VS Code · .vscode/mcp.json", `{\n  "servers": {\n    "${srv.name}": { "type": "http", "url": "${url}" }\n  }\n}`],
  ];
}

function DraftCard({ draft, reason, setReason, busy, decide }: {
  draft: Draft; reason: string; setReason: (v: string) => void; busy: boolean; decide: (d: Draft, confirm: boolean) => void;
}) {
  const isPending = draft.status === "pending";
  const minutes = Math.max(0, Math.round((new Date(draft.expiresAt).getTime() - Date.now()) / 60000));
  const ok = reason.trim().length >= 3 && !busy;
  return (
    <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ font: `700 12px ${MONO}`, color: "#92400e" }}>KLADDE {draft.draftId}</span>
        <span style={{ color: "#92400e" }}>{isPending ? `Afventer bekræftelse · udløber om ${minutes} min` : draft.statusText}</span>
      </div>
      <span style={{ fontSize: 15, fontWeight: 500, color: "#451a03", textWrap: "pretty" }}>{draft.summary}</span>
      {(draft.impact.bullets?.length || draft.impact.warnings?.length) ? (
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3, fontSize: 13, color: "#78350f" }}>
          {draft.impact.bullets?.map((b) => <li key={b}>{b}</li>)}
          {draft.impact.warnings?.map((w) => <li key={w} style={{ color: "#991b1b", fontWeight: 500 }}>{w}</li>)}
        </ul>
      ) : null}
      {isPending && (
        <>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Årsag (gemmes i audit-loggen)"
            style={{ height: 34, padding: "0 10px", border: "1px solid #fcd34d", borderRadius: 8, font: `13px ${SANS}`, background: "#ffffff" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => decide(draft, true)} disabled={!ok} style={{ height: 34, padding: "0 14px", borderRadius: 8, border: 0, cursor: "pointer",
              background: "#0f172a", color: "#ffffff", font: `500 13px ${SANS}`, opacity: ok ? 1 : 0.45, pointerEvents: ok ? "auto" : "none" }}>Bekræft</button>
            <button onClick={() => decide(draft, false)} disabled={busy} style={{ height: 34, padding: "0 14px", borderRadius: 8, border: "1px solid #fcd34d",
              cursor: "pointer", background: "transparent", color: "#92400e", font: `500 13px ${SANS}` }}>Annullér</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Calls to one server: the latest 50, then live over SSE (/api/admin/mcp/stream, LISTEN/NOTIFY on mcp_log). */
function Monitor({ server }: { server: Server }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [live, setLive] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ events: Event[] }>(`/api/admin/mcp/events?server=${server}`).then((r) => setEvents(r.events), (e) => setError(errorText(e)));
  }, [server]);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/admin/mcp/stream?server=${server}`);
    es.addEventListener("call", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Event;
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 200)));
    });
    return () => es.close();
  }, [server, live]);

  const ql = q.trim().toLowerCase();
  const shown = events.filter((e) => !ql || `${e.tool ?? e.method} ${e.user_name ?? ""} ${e.client ?? ""}`.toLowerCase().includes(ql));
  const cols = "80px minmax(0,1.2fr) minmax(0,1fr) 100px 60px";
  return (
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrér på værktøj eller bruger"
          style={{ flex: "1 1 220px", minWidth: 0, height: 32, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: `13px ${SANS}` }} />
        <button onClick={() => setLive(!live)} style={{ display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 8,
          border: "1px solid #e2e8f0", background: "#ffffff", cursor: "pointer", font: `500 12px ${SANS}`, color: "#020817" }}>
          <span style={{ width: 8, height: 8, borderRadius: 9999, background: live ? "#22c55e" : "#94a3b8", animation: live ? "tgpulse 1.6s infinite" : "none" }} />
          {live ? "Live" : "Pause"}
        </button>
      </div>
      {error && <div style={{ padding: 14 }}><ErrorBox>{error}</ErrorBox></div>}
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, padding: "8px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 11,
        letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b" }}>
        <span>Tid</span><span>Værktøj</span><span>Bruger</span><span>Status</span><span style={{ textAlign: "right" }}>ms</span>
      </div>
      {shown.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#64748b", fontSize: 13 }}>Ingen kald endnu.</div>}
      {shown.map((e) => (
        <div key={e.id} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 12 }}>
          <span style={{ fontVariantNumeric: "tabular-nums", color: "#64748b" }}>{fmtTime(e.ts)}</span>
          <span style={{ fontFamily: MONO, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.tool ?? e.method}</span>
          <span style={{ color: "#334155", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {e.user_name ?? "—"}{e.client ? ` · ${e.client}` : e.method === "tools/call" ? " · /admin" : ""}
          </span>
          <span><span style={pill(...(STATUS[e.status] ?? STATUS.ok))}>{e.status}</span></span>
          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#64748b" }}>{e.duration_ms ?? ""}</span>
        </div>
      ))}
    </div>
  );
}
