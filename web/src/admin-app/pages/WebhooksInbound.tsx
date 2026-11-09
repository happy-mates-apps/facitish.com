// /admin/webhooks → Indgående: URLs where other systems deliver webhooks to us (POST /api/hooks/in/<key>).
// Each endpoint decides how a request is verified: Gær signature, HMAC header, fixed header (e.g. Authorization) or
// only the secret URL. Accepted requests are stored and handled by a handler from the code (app/webhooks_in.py).
import { Fragment, useState } from "react";
import { api, errorText } from "../../api";
import { Alert, fmtDate, Json, Loading, useLoad } from "../ui";

type Verify = "gaer" | "hmac" | "token" | "none";
type Endpoint = {
  id: number; name: string; key: string; url: string; verify: Verify; header_name: string | null; secret_hint: string | null;
  handler: string; event_header: string | null; event_field: string | null; id_header: string | null; allowed_ips: string[];
  max_body_kb: number; max_per_minute: number; tolerance_seconds: number; active: boolean; received_count: number;
  rejected_count: number; last_received_at: string | null; last_rejected_at: string | null; last_rejected_reason: string | null;
};
type InEvent = {
  id: string; external_id: string | null; event: string | null; status: string; content_type: string | null;
  headers: Record<string, string>; body: string; body_json: unknown; ip: string | null; attempts: number; result: unknown;
  error: string | null; received_at: string; processed_at: string | null;
};
type Data = { items: Endpoint[]; handlers: { name: string; description: string }[] };

const VERIFY: Record<Verify, [string, string]> = {
  gaer: ["Gær-signatur", "X-Gaer-Signature (t=…,v1=…), som Gærs egne webhooks sender. Tidsstemplet skal være nyt."],
  hmac: ["HMAC-header", "HMAC-SHA256 af body i et header, som sha256=…, hex eller base64 (GitHub, Shopify …)."],
  token: ["Fast header", "Et header med en fast værdi, fx Authorization: Bearer …"],
  none: ["Kun URL", "Ingen header. Den hemmelige URL er beskyttelsen; brug gerne IP-filter."],
};
const REASONS: Record<string, string> = {
  missing_signature: "manglede signatur", bad_signature: "forkert signatur", missing_header: "manglede header",
  bad_token: "forkert værdi", ip_not_allowed: "IP ikke tilladt", too_large: "for stor", rate_limited: "for mange pr. minut",
  inactive: "slået fra", no_secret: "ingen nøgle",
};
const STATUS: Record<string, [string, string]> = {
  received: ["Modtaget", "amber"], processed: ["Behandlet", "green"], failed: ["Fejlet", "red"], ignored: ["Ignoreret", ""],
};

const empty = { name: "", verify: "gaer" as Verify, header_name: "", secret: "", handler: "store", event_header: "",
                event_field: "", id_header: "", allowed_ips: "", max_body_kb: 256, max_per_minute: 120 };

export default function WebhooksInbound() {
  const data = useLoad(() => api.get<Data>("/api/admin/inbound-webhooks"));
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<number | null>(null);
  const [shown, setShown] = useState<{ title: string; url?: string; secret?: string | null; header?: string | null } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, label?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (label) setNotice(label);
      await data.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const body = () => ({
    name: form.name, verify: form.verify, header_name: form.header_name || null, handler: form.handler,
    event_header: form.event_header || null, event_field: form.event_field || null, id_header: form.id_header || null,
    allowed_ips: form.allowed_ips.split(/[\s,]+/).filter(Boolean), max_body_kb: form.max_body_kb, max_per_minute: form.max_per_minute,
    ...(form.secret ? { secret: form.secret } : {}),
  });

  const save = () => act(async () => {
    if (editing) {
      const b = body();
      const r = await api.patch<Endpoint & { secret?: string }>(`/api/admin/inbound-webhooks/${editing}`, {
        ...b, event_header: b.event_header ?? "", event_field: b.event_field ?? "", id_header: b.id_header ?? "",
        header_name: b.header_name ?? undefined,
      });
      if (r.secret) setShown({ title: r.name, secret: r.secret, header: r.header_name });
    } else {
      const r = await api.post<Endpoint & { secret: string | null }>("/api/admin/inbound-webhooks", body());
      setShown({ title: r.name, url: r.url, secret: r.secret, header: r.header_name });
    }
    setForm(empty);
    setEditing(null);
  }, editing ? "Endpointet er gemt." : "Endpointet er oprettet.");

  const edit = (e: Endpoint) => {
    setEditing(e.id);
    setForm({ name: e.name, verify: e.verify, header_name: e.header_name ?? "", secret: "", handler: e.handler,
              event_header: e.event_header ?? "", event_field: e.event_field ?? "", id_header: e.id_header ?? "",
              allowed_ips: e.allowed_ips.join(", "), max_body_kb: e.max_body_kb, max_per_minute: e.max_per_minute });
  };

  return (
    <>
      <p className="muted small" style={{ maxWidth: 820 }}>
        Andre systemer sender til en hemmelig URL. Hvert endpoint vælger, hvordan afsenderen beviser, hvem den er — med
        eller uden auth-header. Godkendte kald gemmes og svares med 202 med det samme; derefter kører en handler fra
        koden som baggrundsjob. Afviste kald gemmes ikke, de tælles kun. Samme leverings-id modtages kun én gang.
      </p>
      <Alert kind="success">{notice}</Alert>
      <Alert>{error || data.error}</Alert>
      {shown && (
        <div className="alert warn">
          <strong>{shown.title}</strong> — gem det her hos afsenderen. {shown.secret ? "Nøglen vises kun nu." : ""}
          <div className="stack small" style={{ marginTop: 8 }}>
            {shown.url && <div className="row"><span>URL</span><code style={{ wordBreak: "break-all" }}>{shown.url}</code><button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(shown.url!)}>Kopiér</button></div>}
            {shown.secret && <div className="row"><span>{shown.header ? `${shown.header}` : "Signeringsnøgle"}</span><code style={{ wordBreak: "break-all" }}>{shown.secret}</code><button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(shown.secret!)}>Kopiér</button></div>}
            <div><button className="btn btn-ghost btn-sm" onClick={() => setShown(null)}>Skjul</button></div>
          </div>
        </div>
      )}
      {!data.data ? <Loading /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Navn</th><th>URL</th><th>Bekræftelse</th><th>Handler</th><th>Modtaget</th><th>Afvist</th><th /></tr></thead>
              <tbody>
                {data.data.items.length === 0 && <tr><td colSpan={7} className="muted">Ingen indgående endpoints endnu.</td></tr>}
                {data.data.items.map((e) => (
                  <tr key={e.id}>
                    <td><strong>{e.name}</strong>{!e.active && <> <span className="pill red">Slået fra</span></>}</td>
                    <td className="mono tiny" style={{ wordBreak: "break-all", maxWidth: 260 }}>{e.url}</td>
                    <td className="small">{VERIFY[e.verify][0]}{e.header_name && e.verify !== "gaer" && e.verify !== "none" ? <div className="muted tiny">{e.header_name}{e.secret_hint ? `: ${e.secret_hint}` : ""}</div> : null}{e.allowed_ips.length > 0 && <div className="muted tiny">IP: {e.allowed_ips.join(", ")}</div>}</td>
                    <td className="mono small">{e.handler}</td>
                    <td className="small"><span className="num">{e.received_count}</span>{e.last_received_at && <div className="muted tiny">{fmtDate(e.last_received_at)}</div>}</td>
                    <td className="small"><span className="num">{e.rejected_count}</span>{e.last_rejected_reason && <div className="muted tiny">{REASONS[e.last_rejected_reason] ?? e.last_rejected_reason} · {fmtDate(e.last_rejected_at)}</div>}</td>
                    <td>
                      <div className="row" style={{ "--gap": "6px", flexWrap: "nowrap" } as React.CSSProperties}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === e.id ? null : e.id)}>Hændelser</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => edit(e)}>Ret</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.patch(`/api/admin/inbound-webhooks/${e.id}`, { active: !e.active }),
                          e.active ? "Endpointet er slået fra." : "Endpointet er slået til.")}>{e.active ? "Slå fra" : "Slå til"}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {open && <EventList endpointId={open} onClose={() => setOpen(null)} />}

          <div className="card">
            <span className="eyebrow">{editing ? "Ret indgående endpoint" : "Nyt indgående endpoint"}</span>
            <div className="filters">
              <label className="field">Navn<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="GitHub" /></label>
              <label className="field">Handler
                <select value={form.handler} onChange={(e) => setForm({ ...form, handler: e.target.value })}>
                  {data.data.handlers.map((h) => <option key={h.name} value={h.name}>{h.name} — {h.description}</option>)}
                </select>
              </label>
            </div>
            <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              <strong className="small">Hvordan beviser afsenderen, hvem den er?</strong>
              {(Object.keys(VERIFY) as Verify[]).map((v) => (
                <label key={v} className="row small">
                  <input type="radio" name="verify" checked={form.verify === v} onChange={() => setForm({ ...form, verify: v })} />
                  <strong>{VERIFY[v][0]}</strong> <span className="muted">{VERIFY[v][1]}</span>
                </label>
              ))}
            </div>
            {form.verify !== "none" && (
              <div className="filters">
                {form.verify !== "gaer" && (
                  <label className="field">Header<input value={form.header_name} onChange={(e) => setForm({ ...form, header_name: e.target.value })}
                    placeholder={form.verify === "token" ? "Authorization" : "X-Hub-Signature-256"} /></label>
                )}
                <label className="field" style={{ flex: 2, minWidth: 260 }}>{form.verify === "token" ? "Værdi" : "Nøgle"}
                  <input type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })}
                         placeholder={editing ? "Tom = behold den gemte" : "Tom = vi laver en, som du giver afsenderen"} />
                </label>
              </div>
            )}
            <div className="filters">
              <label className="field">Hændelse fra header<input value={form.event_header} onChange={(e) => setForm({ ...form, event_header: e.target.value })} placeholder="X-GitHub-Event" /></label>
              <label className="field">… eller JSON-felt<input value={form.event_field} onChange={(e) => setForm({ ...form, event_field: e.target.value })} placeholder="type eller data.event" /></label>
              <label className="field">Leverings-id (dubletter)<input value={form.id_header} onChange={(e) => setForm({ ...form, id_header: e.target.value })} placeholder="X-GitHub-Delivery" /></label>
            </div>
            <div className="filters">
              <label className="field" style={{ flex: 2, minWidth: 260 }}>Tilladte IP-intervaller (valgfri)<input value={form.allowed_ips} onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })} placeholder="192.30.252.0/22, 2001:db8::/32" /></label>
              <label className="field">Maks. størrelse (KB)<input type="number" min={1} max={5120} value={form.max_body_kb} onChange={(e) => setForm({ ...form, max_body_kb: Number(e.target.value) })} /></label>
              <label className="field">Maks. pr. minut<input type="number" min={1} max={10000} value={form.max_per_minute} onChange={(e) => setForm({ ...form, max_per_minute: Number(e.target.value) })} /></label>
            </div>
            <div className="row">
              <button className="btn btn-primary" disabled={!form.name} onClick={save}>{editing ? "Gem" : "Opret"}</button>
              {editing && (
                <>
                  <button className="btn btn-ghost" onClick={() => { setEditing(null); setForm(empty); }}>Fortryd</button>
                  {form.verify !== "none" && <button className="btn btn-outline" onClick={() => act(async () => {
                    if (!confirm("Lav en ny nøgle? Afsenderen skal have den nye, før næste kald.")) return;
                    const r = await api.post<{ secret: string }>(`/api/admin/inbound-webhooks/${editing}/rotate?what=secret`);
                    setShown({ title: form.name, secret: r.secret, header: form.verify === "token" ? form.header_name || "Authorization" : null });
                  })}>Ny nøgle</button>}
                  <button className="btn btn-outline" onClick={() => act(async () => {
                    if (!confirm("Lav en ny URL? Den gamle holder op med at virke med det samme.")) return;
                    const r = await api.post<{ url: string }>(`/api/admin/inbound-webhooks/${editing}/rotate?what=key`);
                    setShown({ title: form.name, url: r.url });
                  })}>Ny URL</button>
                  <button className="btn btn-danger" onClick={() => act(async () => {
                    if (!confirm("Slet endpointet og alle modtagne hændelser?")) return;
                    await api.del(`/api/admin/inbound-webhooks/${editing}`);
                    setEditing(null);
                    setForm(empty);
                  }, "Endpointet er slettet.")}>Slet</button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function EventList({ endpointId, onClose }: { endpointId: number; onClose: () => void }) {
  const list = useLoad(() => api.get<InEvent[]>(`/api/admin/inbound-webhooks/${endpointId}/events`), [endpointId]);
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="spread">
        <span className="eyebrow">Modtagne hændelser</span>
        <div className="row"><button className="btn btn-ghost btn-sm" onClick={list.reload}>Opdatér</button><button className="btn btn-ghost btn-sm" onClick={onClose}>Luk</button></div>
      </div>
      <Alert>{list.error}</Alert>
      {!list.data ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tid</th><th>Hændelse</th><th>Status</th><th>Leverings-id</th><th>Fra</th><th /></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={6} className="muted">Intet modtaget endnu.</td></tr>}
              {list.data.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="small">{fmtDate(e.received_at)}</td>
                    <td className="mono small">{e.event ?? "–"}</td>
                    <td><span className={`pill ${STATUS[e.status]?.[1] ?? ""}`}>{STATUS[e.status]?.[0] ?? e.status}</span>{e.error && <div className="muted tiny">{e.error.slice(0, 120)}</div>}</td>
                    <td className="mono tiny">{e.external_id ?? "–"}</td>
                    <td className="mono tiny">{e.ip ?? "–"}</td>
                    <td>
                      <div className="row" style={{ "--gap": "6px", flexWrap: "nowrap" } as React.CSSProperties}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShown(shown === e.id ? null : e.id)}>Vis</button>
                        <button className="btn btn-outline btn-sm" onClick={async () => { await api.post(`/api/admin/inbound-webhooks/events/${e.id}/replay`); list.reload(); }}>Kør igen</button>
                      </div>
                    </td>
                  </tr>
                  {shown === e.id && (
                    <tr><td colSpan={6}>
                      <div className="stack small">
                        <span className="muted">Headers (uden hemmeligheder)</span><Json value={e.headers} />
                        <span className="muted">Body</span>{e.body_json !== null ? <Json value={e.body_json} /> : <pre className="mono tiny" style={{ whiteSpace: "pre-wrap" }}>{e.body}</pre>}
                        {e.result !== null && <><span className="muted">Resultat</span><Json value={e.result} /></>}
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
