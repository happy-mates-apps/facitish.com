// /admin/secrets — the secret manager (server/app/secret_store.py). Tabs: the secrets, access requests, and each
// group's notification rules. Values are never in a list; they are shown on the secret's own page after a step-up.
import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../../../api";
import { Alert, fmtDay, Loading, Modal, PageHeader, useLoad } from "../../ui";
import { RaciEditor, raciProblems, raciToBody, RequestCard, RoleBadge, STATUS, type AccessRequest, type Meta, type Person, type Raci } from "./shared";

type Item = {
  id: number; group_id: number; group_name: string; name: string; environment: string; tags: string[]; rotation_days: number | null;
  value_changed_at: string | null; my_roles: string[]; my_level: "read" | "write" | null; accountable: Person | null;
  grants: number; pending: number; waiting_for_me: number; status: string;
};
type List = { items: Item[]; waiting_for_me: number };

const TABS = [["secrets", "Hemmeligheder"], ["requests", "Anmodninger"], ["notify", "Notifikationer"]] as const;

function nextRotation(i: Item): string {
  if (!i.rotation_days || !i.value_changed_at) return "—";
  const d = new Date(i.value_changed_at);
  d.setDate(d.getDate() + i.rotation_days);
  return fmtDay(d.toISOString());
}

function NewSecret({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const nav = useNavigate();
  const mine = meta.groups.filter((g) => g.is_member || meta.full);
  const [groupId, setGroupId] = useState<number>(mine[0]?.id ?? 0);
  const group = meta.groups.find((g) => g.id === groupId);
  const defaults = (gid: number): Raci => {
    const g = meta.groups.find((x) => x.id === gid);
    const out: Raci = { [meta.me]: ["R", "A"] };
    for (const m of g?.members ?? []) if (m.id !== meta.me) out[m.id] = ["I"];
    return out;
  };
  const [raci, setRaci] = useState<Raci>(() => defaults(mine[0]?.id ?? 0));
  const [f, setF] = useState({ name: "", environment: "", description: "", value: "", tags: "", rotation_days: "90", approval_rule: "all" });
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const people = useMemo(() => {
    const m = new Map<number, Person>();
    for (const p of [...meta.people, ...(group?.members ?? [])]) m.set(p.id, p);
    return m;
  }, [meta, group]);
  const problems = raciProblems(raci, people);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (!mine.length) {
    return (
      <Modal onClose={onClose}>
        <h3>Ny hemmelighed</h3>
        <p className="small muted">Du er ikke medlem af nogen gruppe. En hemmelighed ejes altid af en gruppe — bed en admin under Grupper om at tilføje dig.</p>
        <div className="row"><button className="btn btn-outline btn-sm" onClick={onClose}>Luk</button></div>
      </Modal>
    );
  }
  const save = async () => {
    setError(null);
    try {
      const r = await api.post<{ id: number }>("/api/admin/secrets", {
        group_id: groupId, name: f.name, environment: f.environment, description: f.description, value: f.value,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), rotation_days: f.rotation_days ? Number(f.rotation_days) : null,
        approval_rule: f.approval_rule, raci: raciToBody(raci),
      });
      nav(`/secrets/${r.id}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal width={760} onClose={onClose}>
      <h3>Ny hemmelighed · trin {step} af 2</h3>
      {step === 1 ? (
        <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 200px" }}>Ejergruppe
              <select value={groupId} onChange={(e) => { const g = Number(e.target.value); setGroupId(g); setRaci(defaults(g)); }}>
                {mine.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: "2 1 240px" }}>Navn
              <input value={f.name} onChange={set("name")} maxLength={120} placeholder="Fx Stripe API-nøgle" />
            </label>
            <label className="field" style={{ flex: "1 1 140px" }}>Miljø
              <input value={f.environment} onChange={set("environment")} maxLength={40} placeholder="produktion" />
            </label>
          </div>
          <label className="field">Værdi
            <textarea value={f.value} onChange={set("value")} rows={3} autoComplete="off" spellCheck={false}
              style={{ fontFamily: "var(--hm-font-mono)" }} />
          </label>
          <label className="field">Beskrivelse
            <input value={f.description} onChange={set("description")} maxLength={1000} />
          </label>
          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "2 1 240px" }}>Tags (kommasepareret)
              <input value={f.tags} onChange={set("tags")} />
            </label>
            <label className="field" style={{ flex: "1 1 160px" }}>Roteres hver
              <select value={f.rotation_days} onChange={set("rotation_days")}>
                <option value="">Ingen rotation</option>
                {[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d}. dag</option>)}
              </select>
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-outline btn-sm" onClick={onClose}>Annullér</button>
            <button className="btn btn-primary btn-sm" disabled={!f.name.trim() || !f.value} onClick={() => setStep(2)}>Næste: ansvar</button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
          <p className="small muted">Standard: du er A og R, resten af {group?.name} er I. A, R og C godkender, når nogen beder om adgang.</p>
          <RaciEditor raci={raci} onChange={setRaci} rows={group?.members ?? []} people={meta.people} />
          <label className="field">Hvem skal godkende adgang?
            <select value={f.approval_rule} onChange={set("approval_rule")}>
              {meta.rules.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          {problems.map((p) => <Alert key={p} kind="warn">{p}</Alert>)}
          <Alert>{error}</Alert>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-outline btn-sm" onClick={() => setStep(1)}>Tilbage</button>
            <button className="btn btn-primary btn-sm" disabled={problems.length > 0} onClick={save}>Opret hemmelighed</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SecretList({ meta }: { meta: Meta }) {
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [mine, setMine] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => api.get<List>(`/api/admin/secrets${archived ? "?archived=true" : ""}`), [archived]);
  const items = (list.data?.items ?? []).filter((i) =>
    (!q || `${i.name} ${i.environment} ${i.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()))
    && (!group || String(i.group_id) === group)
    && (!mine || (mine === "ar" ? i.my_roles.some((r) => r === "A" || r === "R") : mine === "access" ? !!i.my_level : i.my_roles.length > 0)));
  return (
    <>
      {creating && <NewSecret meta={meta} onClose={() => setCreating(false)} />}
      <div className="filters">
        <label className="field">Søg<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Navn, tag eller miljø" /></label>
        <label className="field">Gruppe
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Alle grupper</option>
            {meta.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="field">Min rolle
          <select value={mine} onChange={(e) => setMine(e.target.value)}>
            <option value="">Alle</option><option value="ar">A eller R</option><option value="any">Har en rolle</option><option value="access">Kan se værdien</option>
          </select>
        </label>
        <label className="field">Vis
          <select value={archived ? "1" : ""} onChange={(e) => setArchived(!!e.target.value)}>
            <option value="">Aktive</option><option value="1">Arkiverede</option>
          </select>
        </label>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Ny hemmelighed</button>
      </div>
      <Alert>{list.error}</Alert>
      {list.loading && !list.data ? <Loading /> : items.length === 0 ? <p className="muted">Ingen hemmeligheder.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Navn</th><th>Gruppe</th><th>Accountable</th><th>Din rolle</th><th>Næste rotation</th><th>Adgange</th><th>Status</th></tr></thead>
            <tbody>
              {items.map((i) => {
                const [label, tone] = STATUS[i.status] ?? [i.status, ""];
                return (
                  <tr key={i.id}>
                    <td className="wrap">
                      <Link to={`/secrets/${i.id}`} style={{ fontWeight: 700 }}>{i.name}</Link>
                      <div className="small muted">{[i.environment, ...i.tags].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td><span className="pill">{i.group_name}</span></td>
                    <td>{i.accountable?.name ?? "—"}</td>
                    <td><div className="row" style={{ gap: 4 }}>{i.my_roles.map((r) => <RoleBadge key={r} role={r} />)}
                      {i.my_level && !i.my_roles.some((r) => r === "A" || r === "R") && <span className="pill amber">Har adgang</span>}
                      {!i.my_roles.length && !i.my_level && <span className="muted">—</span>}</div></td>
                    <td>{nextRotation(i)}</td>
                    <td>{i.grants || "—"}</td>
                    <td><span className={`pill ${tone}`}>{i.waiting_for_me ? "Venter på dig" : label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Alle med adgang til denne side ser navn, gruppe og RACI — aldrig værdien.</p>
    </>
  );
}

function Requests() {
  const [scope, setScope] = useState("waiting");
  const list = useLoad(() => api.get<{ items: AccessRequest[] }>(`/api/admin/secrets/requests?scope=${scope}`), [scope]);
  return (
    <>
      <div className="row" role="tablist" style={{ flexWrap: "wrap" }}>
        {[["waiting", "Venter på mig"], ["mine", "Mine anmodninger"], ["open", "Alle åbne"], ["all", "Alle"]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={scope === k} className={`btn btn-sm ${scope === k ? "btn-primary" : "btn-outline"}`} onClick={() => setScope(k)}>{l}</button>
        ))}
      </div>
      <Alert>{list.error}</Alert>
      {list.loading && !list.data ? <Loading /> : list.data?.items.length === 0 ? <p className="muted">Ingen anmodninger.</p> : (
        <div className="stack" style={{ "--gap": "16px" } as CSSProperties}>
          {list.data?.items.map((r) => <RequestCard key={`${r.id}-${r.status}-${r.approved}`} r={r} showSecret onChange={list.reload} />)}
        </div>
      )}
    </>
  );
}

type NotifyData = { group: { id: number; name: string; notify_email: string | null }; can_edit: boolean;
  events: { key: string; label: string; modes: Record<string, string> }[]; audiences: string[] };
const AUD_LABEL: Record<string, string> = { A: "A", R: "R", C: "C", I: "I", grantee: "Med adgang", channel: "Gruppens mail" };

function Notify({ meta }: { meta: Meta }) {
  const [gid, setGid] = useState<number>(meta.groups[0]?.id ?? 0);
  const data = useLoad(() => (gid ? api.get<NotifyData>(`/api/admin/secrets/groups/${gid}/notify`) : Promise.resolve(null)), [gid]);
  const [error, setError] = useState<string | null>(null);
  const change = async (event: string, audience: string, mode: string) => {
    setError(null);
    try {
      await api.put(`/api/admin/secrets/groups/${gid}/notify`, { rules: [{ event, audience, mode }] });
      await data.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (!meta.groups.length) return <p className="muted">Der er ingen grupper endnu.</p>;
  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field">Gruppe
          <select value={gid} onChange={(e) => setGid(Number(e.target.value))}>
            {meta.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        {data.data && <span className="small muted">Gruppens mail: {data.data.group.notify_email ?? "ingen (sættes under Grupper)"}</span>}
      </div>
      <p className="small muted">
        Straks = mail med det samme · Opsamling = én daglig mail · Fra = ingen besked. Godkendere og den, der anmoder, får altid
        besked med det samme. Beskeder indeholder aldrig værdien.
        {data.data && !data.data.can_edit && " Kun gruppens ansvarlige eller en admin med fuld adgang kan ændre reglerne."}
      </p>
      <Alert>{error || data.error}</Alert>
      {data.data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Hændelse</th>{data.data.audiences.map((a) => <th key={a}>{AUD_LABEL[a] ?? a}</th>)}</tr></thead>
            <tbody>
              {data.data.events.map((ev) => (
                <tr key={ev.key}>
                  <td className="wrap"><div style={{ fontWeight: 600 }}>{ev.label}</div><div className="small muted mono">{ev.key}</div></td>
                  {data.data!.audiences.map((a) => (
                    <td key={a}>
                      <select aria-label={`${ev.label} · ${AUD_LABEL[a]}`} value={ev.modes[a]} disabled={!data.data!.can_edit}
                        onChange={(e) => change(ev.key, a, e.target.value)}>
                        <option value="now">Straks</option>
                        {a !== "channel" && <option value="digest">Opsamling</option>}
                        <option value="off">Fra</option>
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function Secrets() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "secrets";
  const meta = useLoad(() => api.get<Meta>("/api/admin/secrets/meta"), []);
  const waiting = useLoad(() => api.get<List>("/api/admin/secrets"), [tab]);
  const n = waiting.data?.waiting_for_me ?? 0;
  return (
    <>
      <PageHeader eyebrow="/admin/secrets" title="Hemmeligheder">
        Nøgler, tokens og adgangskoder — ejet af en gruppe og styret af en RACI. A og R ser og ændrer værdien. Andre får
        adgang, når alle godkendere har sagt ja, og adgangen udløber altid. Hver visning og ændring bliver logget.
      </PageHeader>
      {n > 0 && tab !== "requests" && (
        <Alert kind="warn">
          <strong>{n} {n === 1 ? "anmodning venter" : "anmodninger venter"} på din godkendelse.</strong>{" "}
          <button className="btn btn-outline btn-sm" onClick={() => setParams({ tab: "requests" })}>Se anmodninger</button>
        </Alert>
      )}
      <div className="row" role="tablist" style={{ flexWrap: "wrap" }}>
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? "btn-primary" : "btn-outline"}`}
            onClick={() => setParams(k === "secrets" ? {} : { tab: k })}>
            {label}{k === "requests" && n ? ` · ${n}` : ""}
          </button>
        ))}
      </div>
      <Alert>{meta.error}</Alert>
      {!meta.data ? <Loading /> : tab === "requests" ? <Requests /> : tab === "notify" ? <Notify meta={meta.data} /> : <SecretList meta={meta.data} />}
    </>
  );
}
