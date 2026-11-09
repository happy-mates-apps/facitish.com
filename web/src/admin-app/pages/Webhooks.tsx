// /admin/webhooks: endpoints that get the app's events, signed, with or without an auth header.
// Creating, changing and rotating need a recent second factor (the step-up dialog opens by itself).
import { Fragment, useState } from "react";
import { api, errorText } from "../../api";
import { Alert, fmtDate, Json, Loading, PageHeader, useLoad } from "../ui";
import WebhooksInbound from "./WebhooksInbound";

type Hook = {
  id: number; name: string; url: string; events: string[]; active: boolean; auth_header_name: string | null;
  auth_header_hint: string | null; timeout_seconds: number; max_attempts: number; consecutive_failures: number;
  disabled_reason: string | null; created_at: string; last_success_at: string | null; last_failure_at: string | null;
  deliveries_24h: number; dead_24h: number;
};
type Delivery = {
  id: string; event: string; status: string; attempts: number; last_status: number | null; last_error: string | null;
  last_response: string | null; duration_ms: number | null; payload: unknown; created_at: string; delivered_at: string | null;
};
type Data = { items: Hook[]; events: { key: string; description: string }[] };

const STATUS: Record<string, string> = { pending: "Venter", succeeded: "Leveret", failed: "Prøver igen", dead: "Opgivet" };
const empty = { name: "", url: "https://", events: [] as string[], auth_header_name: "Authorization", auth_header_value: "",
                timeout_seconds: 10, max_attempts: 8 };

export default function Webhooks() {
  const [tab, setTab] = useState<"out" | "in">(() => (window.location.hash === "#indgaaende" ? "in" : "out"));
  const pick = (t: "out" | "in") => {
    setTab(t);
    history.replaceState(null, "", t === "in" ? "#indgaaende" : "#");
  };
  return (
    <>
      <PageHeader eyebrow="/admin/webhooks" title="Webhooks">
        Udgående sender appens hændelser til andre systemer. Indgående giver andre systemer en adresse, de kan sende til.
        Begge kan bruges med eller uden auth-header, og begge kan signeres.
      </PageHeader>
      <div className="row" role="tablist" aria-label="Retning">
        <button role="tab" aria-selected={tab === "out"} className={`btn btn-sm ${tab === "out" ? "btn-dark" : "btn-outline"}`} onClick={() => pick("out")}>Udgående</button>
        <button role="tab" aria-selected={tab === "in"} className={`btn btn-sm ${tab === "in" ? "btn-dark" : "btn-outline"}`} onClick={() => pick("in")}>Indgående</button>
      </div>
      {tab === "out" ? <Outgoing /> : <WebhooksInbound />}
    </>
  );
}

function Outgoing() {
  const data = useLoad(() => api.get<Data>("/api/admin/webhooks"));
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<number | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
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

  const save = () => act(async () => {
    const body = { ...form, auth_header_name: form.auth_header_name || null };
    if (editing) {
      // An empty header field keeps the stored value; "Fjern header" removes it.
      const { auth_header_value, ...rest } = body;
      await api.patch(`/api/admin/webhooks/${editing}`, auth_header_value ? body : rest);
    } else {
      const created = await api.post<Hook & { secret: string }>("/api/admin/webhooks", body);
      setSecret({ name: created.name, value: created.secret });
    }
    setForm(empty);
    setEditing(null);
  }, editing ? "Webhooken er gemt." : "Webhooken er oprettet.");

  const edit = (h: Hook) => {
    setEditing(h.id);
    setForm({ name: h.name, url: h.url, events: h.events, auth_header_name: h.auth_header_name ?? "Authorization",
              auth_header_value: "", timeout_seconds: h.timeout_seconds, max_attempts: h.max_attempts });
  };

  const toggleEvent = (key: string) =>
    setForm((f) => ({ ...f, events: f.events.includes(key) ? f.events.filter((e) => e !== key) : [...f.events, key] }));

  return (
    <>
      <p className="muted small" style={{ maxWidth: 820 }}>
        Send appens hændelser til andre systemer. Hver levering er en POST med JSON, signeret med HMAC-SHA256 i
        headeren X-Gaer-Signature (t=tid,v1=signatur af »tid.body«). Et Authorization-header (eller et andet) kan sendes med,
        hvis modtageren kræver det. Fejl prøves igen med stigende pause; efter 10 opgivne leveringer i træk slås
        webhooken fra. Kun https til offentlige adresser.
      </p>
      <Alert kind="success">{notice}</Alert>
      <Alert>{error || data.error}</Alert>
      {secret && (
        <div className="alert warn">
          <strong>Signeringsnøgle for {secret.name}</strong> — vises kun nu. Gem den hos modtageren.
          <div className="row" style={{ marginTop: 8 }}>
            <code style={{ wordBreak: "break-all" }}>{secret.value}</code>
            <button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(secret.value)}>Kopiér</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSecret(null)}>Skjul</button>
          </div>
        </div>
      )}
      {!data.data ? <Loading /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Navn</th><th>Adresse</th><th>Hændelser</th><th>Auth-header</th><th>Status</th><th>Sidste døgn</th><th /></tr></thead>
              <tbody>
                {data.data.items.length === 0 && <tr><td colSpan={7} className="muted">Ingen webhooks endnu.</td></tr>}
                {data.data.items.map((h) => (
                  <tr key={h.id}>
                    <td><strong>{h.name}</strong></td>
                    <td className="mono small" style={{ wordBreak: "break-all" }}>{h.url}</td>
                    <td className="small">{h.events.includes("*") ? "Alle" : h.events.join(", ")}</td>
                    <td className="small">{h.auth_header_name ? <>{h.auth_header_name}: <span className="mono">{h.auth_header_hint}</span></> : <span className="muted">Ingen</span>}</td>
                    <td className="small">
                      {h.active ? <span className="pill green">Aktiv</span> : <span className="pill red">Slået fra</span>}
                      {h.disabled_reason && <div className="muted tiny">{h.disabled_reason}</div>}
                      {h.last_success_at && <div className="muted tiny">Sidst leveret {fmtDate(h.last_success_at)}</div>}
                    </td>
                    <td className="num small">{h.deliveries_24h}{h.dead_24h ? <span style={{ color: "#b91c1c" }}> · {h.dead_24h} opgivet</span> : null}</td>
                    <td>
                      <div className="row" style={{ "--gap": "6px", flexWrap: "nowrap" } as React.CSSProperties}>
                        <button className="btn btn-outline btn-sm" onClick={() => act(async () => {
                          const r = await api.post<{ ok: boolean; status: number | null; error: string | null }>(`/api/admin/webhooks/${h.id}/test`);
                          if (!r.ok) throw new Error(`Testen fejlede: ${r.error ?? r.status}`);
                        }, "Testen blev leveret.")}>Send test</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === h.id ? null : h.id)}>Leveringer</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => edit(h)}>Ret</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.patch(`/api/admin/webhooks/${h.id}`, { active: !h.active }),
                          h.active ? "Webhooken er slået fra." : "Webhooken er slået til.")}>{h.active ? "Slå fra" : "Slå til"}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {open && <DeliveryList hookId={open} onClose={() => setOpen(null)} />}

          <div className="card">
            <span className="eyebrow">{editing ? "Ret webhook" : "Ny webhook"}</span>
            <div className="filters">
              <label className="field">Navn<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="CRM" /></label>
              <label className="field" style={{ flex: 2, minWidth: 280 }}>Adresse<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></label>
            </div>
            <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
              <strong className="small">Hændelser</strong>
              <label className="row small"><input type="checkbox" checked={form.events.includes("*")} onChange={() => toggleEvent("*")} /> Alle hændelser, også nye</label>
              {data.data.events.map((ev) => (
                <label key={ev.key} className="row small">
                  <input type="checkbox" checked={form.events.includes(ev.key)} disabled={form.events.includes("*")} onChange={() => toggleEvent(ev.key)} />
                  <code>{ev.key}</code> <span className="muted">{ev.description}</span>
                </label>
              ))}
            </div>
            <div className="filters">
              <label className="field">Auth-header (valgfri)<input value={form.auth_header_name} onChange={(e) => setForm({ ...form, auth_header_name: e.target.value })} placeholder="Authorization" /></label>
              <label className="field" style={{ flex: 2, minWidth: 260 }}>Værdi
                <input type="password" autoComplete="off" value={form.auth_header_value} onChange={(e) => setForm({ ...form, auth_header_value: e.target.value })}
                       placeholder={editing ? "Tom = behold den gemte" : "Bearer … (tom = intet header)"} />
              </label>
              <label className="field">Timeout (sek.)<input type="number" min={1} max={30} value={form.timeout_seconds} onChange={(e) => setForm({ ...form, timeout_seconds: Number(e.target.value) })} /></label>
              <label className="field">Forsøg<input type="number" min={1} max={20} value={form.max_attempts} onChange={(e) => setForm({ ...form, max_attempts: Number(e.target.value) })} /></label>
            </div>
            <p className="muted tiny">Værdien gemmes krypteret og vises aldrig igen; kun de sidste fire tegn.</p>
            <div className="row">
              <button className="btn btn-primary" disabled={!form.name || !form.url || !form.events.length} onClick={save}>{editing ? "Gem" : "Opret"}</button>
              {editing && (
                <>
                  <button className="btn btn-ghost" onClick={() => { setEditing(null); setForm(empty); }}>Fortryd</button>
                  <button className="btn btn-outline" onClick={() => act(() => api.patch(`/api/admin/webhooks/${editing}`, { auth_header_value: "" }), "Auth-headeren er fjernet.")}>Fjern header</button>
                  <button className="btn btn-outline" onClick={() => act(async () => {
                    if (!confirm("Lav en ny signeringsnøgle? Modtageren skal have den nye, før næste levering.")) return;
                    const r = await api.post<{ secret: string }>(`/api/admin/webhooks/${editing}/rotate-secret`);
                    setSecret({ name: form.name, value: r.secret });
                  })}>Ny signeringsnøgle</button>
                  <button className="btn btn-danger" onClick={() => act(async () => {
                    if (!confirm("Slet webhooken og alle dens leveringer?")) return;
                    await api.del(`/api/admin/webhooks/${editing}`);
                    setEditing(null);
                    setForm(empty);
                  }, "Webhooken er slettet.")}>Slet</button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function DeliveryList({ hookId, onClose }: { hookId: number; onClose: () => void }) {
  const list = useLoad(() => api.get<Delivery[]>(`/api/admin/webhooks/${hookId}/deliveries`), [hookId]);
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="spread">
        <span className="eyebrow">Seneste leveringer</span>
        <div className="row"><button className="btn btn-ghost btn-sm" onClick={list.reload}>Opdatér</button><button className="btn btn-ghost btn-sm" onClick={onClose}>Luk</button></div>
      </div>
      <Alert>{list.error}</Alert>
      {!list.data ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tid</th><th>Hændelse</th><th>Status</th><th>Forsøg</th><th>Svar</th><th /></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={6} className="muted">Ingen leveringer endnu.</td></tr>}
              {list.data.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td className="small">{fmtDate(d.created_at)}</td>
                    <td className="mono small">{d.event}</td>
                    <td><span className={`pill ${d.status === "succeeded" ? "green" : d.status === "dead" ? "red" : "amber"}`}>{STATUS[d.status] ?? d.status}</span></td>
                    <td className="num">{d.attempts}</td>
                    <td className="small">{d.last_status ?? "–"}{d.duration_ms !== null ? ` · ${d.duration_ms} ms` : ""}{d.last_error ? <div className="muted tiny">{d.last_error}</div> : null}</td>
                    <td>
                      <div className="row" style={{ "--gap": "6px", flexWrap: "nowrap" } as React.CSSProperties}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShown(shown === d.id ? null : d.id)}>Vis</button>
                        <button className="btn btn-outline btn-sm" onClick={async () => { await api.post(`/api/admin/webhooks/deliveries/${d.id}/redeliver`); list.reload(); }}>Send igen</button>
                      </div>
                    </td>
                  </tr>
                  {shown === d.id && (
                    <tr><td colSpan={6}>
                      <div className="stack small"><span className="muted">X-Gaer-Delivery: <code>{d.id}</code></span><Json value={d.payload} />
                        {d.last_response && <><span className="muted">Svar:</span><pre className="mono tiny" style={{ whiteSpace: "pre-wrap" }}>{d.last_response}</pre></>}
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
