// /admin/groups — groups as a general feature (server/app/groups.py): name, description, a mail address for the
// group's notifications, and members (member or manager). Used by /admin/secrets, where a group owns secrets and can
// be given access to one. Adding a member needs a fresh second factor: it can give access to secrets.
import { useState, type CSSProperties } from "react";
import { api, errorText } from "../../api";
import { Alert, fmtDay, Loading, PageHeader, useLoad, useToast } from "../ui";

type Group = { id: number; slug: string; name: string; description: string; notify_email: string | null; members: number; secrets: number };
type Member = { id: number; display_name: string | null; email: string | null; user_role: string; role: "member" | "manager"; added_at: string };
type Full = Group & { members: Member[]; secrets: { id: number; name: string; environment: string }[] };
type User = { id: number; email: string | null; phone: string | null; display_name: string | null; role: string };

function GroupPanel({ id, onChange }: { id: number; onChange: () => void }) {
  const toast = useToast();
  const g = useLoad(() => api.get<Full>(`/api/admin/groups/${id}`), [id]);
  const [q, setQ] = useState("");
  const users = useLoad(() => api.get<{ items: User[] }>(`/api/admin/users?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`), [q]);
  const [pick, setPick] = useState("");
  const [edit, setEdit] = useState<{ name: string; description: string; notify_email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast(done);
      await g.reload();
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (g.error) return <Alert>{g.error}</Alert>;
  if (!g.data) return <Loading />;
  const group = g.data;
  const candidates = (users.data?.items ?? []).filter((u) => !group.members.some((m) => m.id === u.id));
  return (
    <div className="card">
      <div className="spread">
        <h3>{group.name} <span className="pill mono">{group.slug}</span></h3>
        {!edit && <button className="btn btn-outline btn-sm" onClick={() => setEdit({ name: group.name, description: group.description, notify_email: group.notify_email ?? "" })}>Rediger</button>}
      </div>
      {edit ? (
        <div className="stack" style={{ "--gap": "10px" } as CSSProperties}>
          <label className="field">Navn<input value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field">Beskrivelse<input value={edit.description} maxLength={500} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
          <label className="field">Gruppens mail (fx en fællespostkasse — får gruppens beskeder)
            <input type="email" value={edit.notify_email} onChange={(e) => setEdit({ ...edit, notify_email: e.target.value })} />
          </label>
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={() => act(async () => { await api.patch(`/api/admin/groups/${id}`, edit); setEdit(null); }, "Gemt")}>Gem</button>
            <button className="btn btn-outline btn-sm" onClick={() => setEdit(null)}>Annullér</button>
          </div>
        </div>
      ) : (
        <p className="small muted">{group.description || "Ingen beskrivelse."} · Mail: {group.notify_email ?? "ingen"}</p>
      )}
      <Alert>{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Medlem</th><th>Rolle i gruppen</th><th>Tilføjet</th><th /></tr></thead>
          <tbody>
            {group.members.length === 0 && <tr><td colSpan={4} className="muted">Ingen medlemmer endnu.</td></tr>}
            {group.members.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.display_name || m.email || `#${m.id}`}</strong>{m.user_role === "admin" && <span className="pill blue" style={{ marginLeft: 6 }}>admin</span>}
                  <div className="small muted">{m.email}</div></td>
                <td>
                  <select aria-label={`Rolle for ${m.display_name || m.email}`} value={m.role}
                    onChange={(e) => act(() => api.put(`/api/admin/groups/${id}/members/${m.id}`, { role: e.target.value }), "Rolle ændret")}>
                    <option value="member">Medlem</option><option value="manager">Ansvarlig for gruppen</option>
                  </select>
                </td>
                <td>{fmtDay(m.added_at)}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn btn-ghost btn-sm" style={{ color: "#b91c1c" }} onClick={() => act(() => api.del(`/api/admin/groups/${id}/members/${m.id}`), "Fjernet fra gruppen")}>Fjern</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 200px" }}>Søg bruger<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Navn eller e-mail" /></label>
        <label className="field" style={{ flex: "2 1 260px" }}>Tilføj
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Vælg …</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email || u.phone}{u.role === "admin" ? " · admin" : ""}</option>)}
          </select>
        </label>
        <button className="btn btn-primary btn-sm" disabled={!pick}
          onClick={() => act(async () => { await api.put(`/api/admin/groups/${id}/members/${pick}`, { role: "member" }); setPick(""); }, "Tilføjet")}>Tilføj medlem</button>
      </div>
      <p className="small muted">
        Gruppen ejer {group.secrets.length} {group.secrets.length === 1 ? "hemmelighed" : "hemmeligheder"}.
        Har gruppen fået adgang til en hemmelighed, får nye medlemmer den også — A og R får besked.
      </p>
      {group.secrets.length === 0 && (
        <div className="row"><button className="btn btn-danger btn-sm" onClick={() => {
          if (confirm(`Slet gruppen ${group.name}?`)) void act(() => api.del(`/api/admin/groups/${id}`), "Gruppen er slettet");
        }}>Slet gruppe</button></div>
      )}
    </div>
  );
}

export default function Groups() {
  const list = useLoad(() => api.get<{ items: Group[] }>("/api/admin/groups"), []);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      const g = await api.post<Group>("/api/admin/groups", { name });
      setName("");
      await list.reload();
      setSelected(g.id);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const items = list.data?.items ?? [];
  const current = items.some((g) => g.id === selected) ? selected : null;
  return (
    <>
      <PageHeader eyebrow="/admin/groups" title="Grupper">
        Navngivne grupper af brugere. Bruges af Hemmeligheder, hvor en gruppe ejer hemmeligheder og kan få adgang til dem.
        Gruppens ansvarlige kan ændre, hvem i gruppen der får besked om hvad.
      </PageHeader>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 260px" }}>Ny gruppe<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Fx Betaling" /></label>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={create}>Opret</button>
      </div>
      <Alert>{error || list.error}</Alert>
      {list.loading && !list.data ? <Loading /> : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <div className="table-wrap" style={{ flex: "1 1 320px" }}>
            <table>
              <thead><tr><th>Gruppe</th><th>Medlemmer</th><th>Hemmeligheder</th></tr></thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={3} className="muted">Ingen grupper endnu.</td></tr>}
                {items.map((g) => (
                  <tr key={g.id} className="tg-row" style={{ background: g.id === current ? "#eff6ff" : undefined }}>
                    <td><button className="btn btn-ghost btn-sm" style={{ fontWeight: 700, color: "#020817", padding: 0 }} onClick={() => setSelected(g.id)}>{g.name}</button></td>
                    <td>{g.members}</td>
                    <td>{g.secrets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ flex: "999 1 520px", minWidth: 0 }}>
            {current ? <GroupPanel key={current} id={current} onChange={list.reload} /> : <p className="muted">Vælg en gruppe.</p>}
          </div>
        </div>
      )}
    </>
  );
}
