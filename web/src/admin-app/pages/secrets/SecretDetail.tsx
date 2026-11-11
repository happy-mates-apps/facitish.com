// /admin/secrets/:id — one secret: the value (shown for 30 seconds after a step-up, the clipboard cleared after 30
// seconds), versions, the RACI, who has access, requests and the activity. Rules in server/app/secret_store.py.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../../../api";
import { Alert, fmtDate, fmtDay, Loading, Modal, PageHeader, useLoad, useToast } from "../../ui";
import { RaciEditor, raciProblems, raciToBody, RequestCard, RoleBadge, STATUS, type AccessRequest, type Meta, type Person, type Raci, type Role } from "./shared";

type Detail = {
  id: number; group_id: number; group_name: string; name: string; environment: string; description: string; tags: string[];
  approval_rule: string; rule_label: string; rotation_days: number | null; expires_at: string | null; current_version: number;
  value_changed_at: string | null; archived_at: string | null; status: string; my_roles: Role[]; my_level: "read" | "write" | null;
  can_edit_raci: boolean; can_manage: boolean; group_role: string | null;
  raci: (Person & { roles: Role[] })[];
  versions: { version: number; current: boolean; hint: string; length: number | null; created_at: string; superseded_at: string | null; created_by: Person | null }[];
  grants: { id: number; level: string; level_label: string; granted_at: string; expires_at: string; user: Person | null; group: { id: number; name: string } | null;
    source: { id: number; key: string; name: string; hosts: string[] } | null }[];
  used_by: { id: number; key: string; name: string; hosts: string[]; used_as: string[] }[];
  requests: AccessRequest[];
  activity: { ts: string; action: string; actor: Person | null; detail: Record<string, unknown> }[];
};

const ACTION: Record<string, string> = {
  create: "oprettede hemmeligheden", update: "ændrede oplysningerne", "secret.revealed": "viste værdien",
  "secret.value_changed": "skiftede værdien", "secret.raci_changed": "ændrede RACI", "secret.access_requested": "anmodede om adgang",
  "secret.access_approved": "godkendte en anmodning", "secret.access_rejected": "afviste en anmodning",
  "secret.access_granted": "Adgang givet", "secret.access_ended": "afsluttede en adgang", "secret.access_expired": "En anmodning udløb",
  "secret.access_cancelled": "trak en anmodning tilbage", "secret.archived": "arkiverede hemmeligheden",
  "secret.orphaned": "A er slettet — hemmeligheden mangler en ansvarlig", "secret.access_via_group": "En ny gruppemedlem fik adgang via gruppen",
};

function addDays(iso: string | null, days: number | null): string {
  if (!iso || !days) return "—";
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return fmtDay(d.toISOString());
}

function Value({ s, reload }: { s: Detail; reload: () => void }) {
  const toast = useToast();
  const [shown, setShown] = useState<{ value: string; version: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearInterval(timer.current), []);
  const reveal = async (version?: number) => {
    setError(null);
    try {
      const r = await api.post<{ value: string; version: number; show_seconds: number }>(
        `/api/admin/secrets/${s.id}/reveal${version ? `?version=${version}` : ""}`);
      setShown(r);
      setLeft(r.show_seconds);
      window.clearInterval(timer.current);
      timer.current = window.setInterval(() => setLeft((n) => {
        if (n <= 1) { window.clearInterval(timer.current); setShown(null); return 0; }
        return n - 1;
      }), 1000);
      return r.value;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  const copy = async () => {
    const value = shown?.value ?? await reveal();
    if (!value) return;
    await navigator.clipboard?.writeText(value).catch(() => {});
    toast("Kopieret. Udklipsholderen ryddes om 30 sekunder.");
    window.setTimeout(() => { navigator.clipboard?.writeText("").catch(() => {}); }, 30_000);
  };
  const save = async () => {
    setError(null);
    try {
      await api.put(`/api/admin/secrets/${s.id}/value`, { value: draft });
      setDraft("");
      setEditing(false);
      setShown(null);
      toast("Ny version gemt");
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const cur = s.versions.find((v) => v.current);
  return (
    <div className="card">
      <div className="spread">
        <h3>Værdi</h3>
        <span className="small muted">Version {s.current_version}{cur?.created_by && ` · ${fmtDate(cur.created_at)} af ${cur.created_by.name}`}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 8, background: "#0f172a", color: "#e2e8f0",
        fontFamily: "var(--hm-font-mono)", fontSize: 14, overflowX: "auto", whiteSpace: shown ? "pre-wrap" : "nowrap", wordBreak: "break-all" }}>
        {shown ? shown.value : s.my_level ? `••••••••••••••••••••${cur?.hint ?? ""}` : "Skjult — du har ikke adgang"}
      </div>
      {shown && <p className="small muted">Skjules om {left} sek.{shown.version !== s.current_version && ` (version ${shown.version})`}</p>}
      <Alert>{error}</Alert>
      {s.my_level ? (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {shown ? <button className="btn btn-outline btn-sm" onClick={() => setShown(null)}>Skjul</button>
            : <button className="btn btn-primary btn-sm" onClick={() => reveal()}>Vis værdi</button>}
          <button className="btn btn-outline btn-sm" onClick={copy}>Kopiér</button>
          {s.my_level === "write" && <button className="btn btn-outline btn-sm" onClick={() => setEditing(!editing)}>Skift værdi</button>}
          <span className="small muted">Kræver din anden faktor · hver visning logges</span>
        </div>
      ) : !s.archived_at && <p className="small muted">Du kan se navn og ansvar, men ikke værdien. Anmod om adgang nedenfor.</p>}
      {editing && (
        <div className="stack" style={{ "--gap": "8px" } as CSSProperties}>
          <label className="field">Ny værdi
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoComplete="off" spellCheck={false}
              style={{ fontFamily: "var(--hm-font-mono)" }} />
          </label>
          <div className="row"><button className="btn btn-primary btn-sm" disabled={!draft} onClick={save}>Gem som ny version</button>
            <button className="btn btn-outline btn-sm" onClick={() => setEditing(false)}>Annullér</button></div>
        </div>
      )}
      <div className="row small" style={{ flexWrap: "wrap", gap: 20, paddingTop: 8, borderTop: "1px solid var(--hm-border)" }}>
        <span><span className="muted">Rotation:</span> {s.rotation_days ? `hver ${s.rotation_days}. dag` : "ingen"}</span>
        <span><span className="muted">Næste rotation:</span> {addDays(s.value_changed_at, s.rotation_days)}</span>
        <span><span className="muted">Udløber hos leverandør:</span> {s.expires_at ? fmtDay(s.expires_at) : "ingen dato"}</span>
      </div>
    </div>
  );
}

function RequestAccess({ s, meta, onClose, onDone }: { s: Detail; meta: Meta; onClose: () => void; onDone: () => void }) {
  const [who, setWho] = useState(s.my_level || s.my_roles.some((r) => r === "A" || r === "R") ? "person" : "me");
  const [person, setPerson] = useState("");
  const [group, setGroup] = useState("");
  const [level, setLevel] = useState("write");
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setError(null);
    try {
      await api.post(`/api/admin/secrets/${s.id}/requests`, {
        grantee_user_id: who === "person" ? Number(person) : null, grantee_group_id: who === "group" ? Number(group) : null,
        level, days, reason });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const ok = reason.trim().length >= 3 && (who !== "person" || person) && (who !== "group" || group);
  return (
    <Modal width={560} onClose={onClose}>
      <h3>{who === "me" ? "Anmod om adgang" : "Giv adgang"}</h3>
      <p className="small muted">Godkendes af: {s.rule_label}. Hverken den, der anmoder, eller den, der får adgang, kan godkende.</p>
      <label className="field">Hvem skal have adgang?
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="me">Mig selv</option><option value="person">En anden administrator</option><option value="group">En gruppe</option>
        </select>
      </label>
      {who === "person" && (
        <label className="field">Person
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Vælg …</option>
            {meta.people.filter((p) => p.id !== meta.me).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {who === "group" && (
        <label className="field">Gruppe (gælder medlemmer, der er administratorer med adgang til Hemmeligheder)
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Vælg …</option>
            {meta.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="field" style={{ flex: "1 1 160px" }}>Niveau
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {meta.levels.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: "1 1 160px" }}>Periode
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90, 180, 365].filter((d) => d <= meta.max_days).map((d) => <option key={d} value={d}>{d} {d === 1 ? "dag" : "dage"}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Begrundelse
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
      </label>
      <Alert>{error}</Alert>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-outline btn-sm" onClick={onClose}>Annullér</button>
        <button className="btn btn-primary btn-sm" disabled={!ok} onClick={send}>Send til godkendelse</button>
      </div>
    </Modal>
  );
}

function EditRaci({ s, meta, onClose, onDone }: { s: Detail; meta: Meta; onClose: () => void; onDone: () => void }) {
  const [raci, setRaci] = useState<Raci>(() => Object.fromEntries(s.raci.map((p) => [p.id, p.roles])));
  const [rule, setRule] = useState(s.approval_rule);
  const [error, setError] = useState<string | null>(null);
  const group = meta.groups.find((g) => g.id === s.group_id);
  const people = useMemo(() => {
    const m = new Map<number, Person>();
    for (const p of [...s.raci, ...meta.people, ...(group?.members ?? [])]) m.set(p.id, p);
    return m;
  }, [s, meta, group]);
  const problems = raciProblems(raci, people);
  const save = async () => {
    setError(null);
    try {
      await api.put(`/api/admin/secrets/${s.id}/raci`, { raci: raciToBody(raci) });
      if (rule !== s.approval_rule) await api.patch(`/api/admin/secrets/${s.id}`, { approval_rule: rule });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal width={760} onClose={onClose}>
      <h3>RACI for {s.name}</h3>
      <RaciEditor raci={raci} onChange={setRaci} rows={[...(group?.members ?? []), ...s.raci.filter((p) => !group?.members.some((m) => m.id === p.id))]} people={meta.people} />
      <label className="field">Hvem skal godkende adgang?
        <select value={rule} onChange={(e) => setRule(e.target.value)}>
          {meta.rules.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </label>
      {problems.map((p) => <Alert key={p} kind="warn">{p}</Alert>)}
      <Alert>{error}</Alert>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-outline btn-sm" onClick={onClose}>Annullér</button>
        <button className="btn btn-primary btn-sm" disabled={problems.length > 0} onClick={save}>Gem RACI</button>
      </div>
    </Modal>
  );
}

export default function SecretDetail() {
  const { id } = useParams();
  const toast = useToast();
  const d = useLoad(() => api.get<Detail>(`/api/admin/secrets/${id}`), [id]);
  const meta = useLoad(() => api.get<Meta>("/api/admin/secrets/meta"), []);
  const [modal, setModal] = useState<"request" | "raci" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      await d.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (d.error) return <Alert>{d.error}</Alert>;
  if (!d.data || !meta.data) return <Loading />;
  const s = d.data;
  const [label, tone] = STATUS[s.status] ?? [s.status, ""];
  const isA = s.my_roles.includes("A");
  return (
    <>
      {modal === "request" && <RequestAccess s={s} meta={meta.data} onClose={() => setModal(null)} onDone={() => { setModal(null); toast("Sendt til godkendelse"); d.reload(); }} />}
      {modal === "raci" && <EditRaci s={s} meta={meta.data} onClose={() => setModal(null)} onDone={() => { setModal(null); toast("RACI gemt"); d.reload(); }} />}
      <PageHeader eyebrow={`/admin/secrets · ${s.group_name}`} title={<>{s.name}{s.environment && <span className="pill red" style={{ marginLeft: 10, verticalAlign: "middle" }}>{s.environment}</span>}</>}>
        {s.description || "Ingen beskrivelse."}
      </PageHeader>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Link to="/secrets" className="btn btn-outline btn-sm">← Alle hemmeligheder</Link>
        <span className={`pill ${tone}`}>{label}</span>
        {s.tags.map((t) => <span key={t} className="pill">{t}</span>)}
        <span style={{ flex: 1 }} />
        {!s.archived_at && <button className="btn btn-outline btn-sm" onClick={() => setModal("request")}>{s.my_level ? "Giv adgang …" : "Anmod om adgang"}</button>}
        {s.can_edit_raci && !s.archived_at && <button className="btn btn-outline btn-sm" onClick={() => setModal("raci")}>Rediger RACI</button>}
        {isA && !s.archived_at && (
          <button className="btn btn-danger btn-sm" onClick={() => {
            const reason = prompt("Hvorfor arkiverer du hemmeligheden? Al adgang lukkes.");
            if (reason !== null) void act(() => api.post(`/api/admin/secrets/${s.id}/archive`, { reason }), "Arkiveret");
          }}>Arkivér</button>
        )}
      </div>
      {s.status === "orphaned" && <Alert kind="warn">Hemmeligheden mangler en ansvarlig (A). {s.can_edit_raci ? "Vælg en ny A under Rediger RACI." : "En admin med fuld adgang kan vælge en ny."}</Alert>}
      <Alert>{error}</Alert>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div className="stack" style={{ flex: "999 1 520px", minWidth: 0, "--gap": "20px" } as CSSProperties}>
          <Value s={s} reload={d.reload} />

          <div className="card">
            <h3>Adgang til værdien</h3>
            {s.grants.length === 0 ? <p className="small muted">Kun A og R. Ingen har fået adgang.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Hvem</th><th>Niveau</th><th>Givet</th><th>Udløber</th><th /></tr></thead>
                  <tbody>
                    {s.grants.map((g) => (
                      <tr key={g.id}>
                        <td>{g.source ? <>API-kilde: <Link to={`/data/connect?source=${g.source.id}`}>{g.source.name}</Link>
                          <div className="small muted">sendes kun til {g.source.hosts.join(", ")}</div></> : g.group ? `Gruppe: ${g.group.name}` : g.user?.name}</td>
                        <td>{g.level_label}</td>
                        <td>{fmtDay(g.granted_at)}</td>
                        <td>{fmtDay(g.expires_at)}</td>
                        <td style={{ textAlign: "right" }}>
                          {s.can_manage && <button className="btn btn-ghost btn-sm" style={{ color: "#b91c1c" }}
                            onClick={() => act(() => api.post(`/api/admin/secrets/${s.id}/grants/${g.id}/revoke`), "Adgangen er tilbagekaldt")}>Tilbagekald</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {s.used_by.length > 0 && (
            <div className="card">
              <h3>Bruges af API-kilder</h3>
              <p className="small muted">Kilderne nævner hemmeligheden i deres beskrivelse. En kilde kan kun bruge værdien med en godkendt adgang „Brug i kilde“, og ingen person kan se den gennem den.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Kilde</th><th>Bruges som</th><th>Værter</th><th>Adgang</th></tr></thead>
                  <tbody>
                    {s.used_by.map((u) => {
                      const g = s.grants.find((x) => x.source?.id === u.id);
                      return (
                        <tr key={u.id}>
                          <td><Link to={`/data/connect?source=${u.id}`}>{u.name}</Link> <span className="muted small">{u.key}</span></td>
                          <td className="small">{u.used_as.map((x) => (x === "auth" ? "Godkendelse" : x.replace("header:", "Header "))).join(", ")}</td>
                          <td className="small">{u.hosts.join(", ")}</td>
                          <td>{g ? <span className="pill green">Til {fmtDay(g.expires_at)}</span> : <span className="pill">Ingen</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {s.requests.length > 0 && (
            <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
              <h3>Anmodninger</h3>
              {s.requests.map((r) => <RequestCard key={`${r.id}-${r.status}-${r.approved}`} r={r} onChange={d.reload} />)}
            </div>
          )}

          <div className="card">
            <h3>Aktivitet</h3>
            {s.activity.map((a, i) => (
              <div key={i} className="row small" style={{ alignItems: "baseline", borderBottom: "1px solid var(--hm-muted)", paddingBottom: 6 }}>
                <span className="muted" style={{ width: 140, flex: "none" }}>{fmtDate(a.ts)}</span>
                <span style={{ flex: 1 }}>{a.actor ? <strong>{a.actor.name}</strong> : null} {ACTION[a.action] ?? a.action}
                  {typeof a.detail.version === "number" && ` (v${a.detail.version})`}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stack" style={{ flex: "1 1 300px", minWidth: 0, "--gap": "20px" } as CSSProperties}>
          <div className="card">
            <h3>RACI</h3>
            {s.raci.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}><strong>{p.name}</strong>{p.id === meta.data!.me && <span className="muted"> (dig)</span>}
                  {!p.eligible && p.roles.some((r) => r !== "I") && <span className="pill red" style={{ marginLeft: 6 }}>Kan ikke handle</span>}</span>
                <span className="row" style={{ gap: 4 }}>{p.roles.map((r) => <RoleBadge key={r} role={r} />)}</span>
              </div>
            ))}
            <p className="small muted">Godkendelse af adgang: <strong>{s.rule_label}</strong>.</p>
          </div>

          <div className="card">
            <h3>Versioner</h3>
            {s.versions.map((v) => (
              <div key={v.version} className="spread small">
                <span><strong>v{v.version}</strong>{v.current ? " · nu" : ""}</span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="muted">{fmtDay(v.created_at)}{v.created_by && ` · ${v.created_by.name}`}</span>
                  {!v.current && s.my_level === "write" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/api/admin/secrets/${s.id}/versions/${v.version}/restore`), `Version ${v.version} er gendannet som ny version`)}>Gendan</button>
                  )}
                </span>
              </div>
            ))}
            <p className="small muted">Gamle versioner slettes efter opbevaringsperioden (Jobs og oprydning).</p>
          </div>
        </div>
      </div>
    </>
  );
}
