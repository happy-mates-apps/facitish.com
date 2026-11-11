// Shared parts of /admin/secrets (server/app/secret_store.py, routes/admin_secrets.py): types, the RACI badges and
// matrix editor, and the request card with approve/reject.
import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../../../api";
import { Alert, fmtDate, fmtDay } from "../../ui";

export type Role = "R" | "A" | "C" | "I";
export const ROLES: Role[] = ["R", "A", "C", "I"];
export const ROLE_LABEL: Record<Role, string> = { R: "Responsible · udfører", A: "Accountable · ejer", C: "Consulted · spørges", I: "Informed · orienteres" };
export type Person = { id: number; name: string; email: string | null; eligible: boolean };
export type GroupMeta = {
  id: number; slug: string; name: string; description: string; notify_email: string | null;
  members: (Person & { group_role: "member" | "manager" })[]; is_member: boolean; is_manager: boolean;
};
export type Meta = {
  groups: GroupMeta[]; people: Person[]; me: number; full: boolean;
  rules: { key: string; label: string }[]; levels: { key: string; label: string }[]; events: { key: string; label: string }[];
  max_days: number;
};
export type Raci = Record<number, Role[]>;
export type Approval = { approver: Person | null; roles: string[]; decision: "pending" | "approved" | "rejected"; note: string | null; decided_at: string | null };
export type AccessRequest = {
  id: number; secret_id: number; secret_name?: string; environment?: string; group_name?: string;
  requester: Person | null; grantee: Person | null; grantee_group: { id: number; name: string } | null;
  level: "read" | "write"; level_label: string; days: number; reason: string; status: string; rule_label: string; fallback: boolean;
  created_at: string; expires_at: string; decided_at: string | null; approvals: Approval[]; approved: number; total: number;
  can_decide: boolean; own: boolean;
};

const BADGE: Record<string, CSSProperties> = {
  A: { background: "#0f172a", color: "#ffffff" },
  R: { background: "#2563eb", color: "#ffffff" },
  C: { background: "#dbeafe", color: "#1e40af" },
  I: { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" },
  admin: { background: "#fcbf49", color: "#0f172a" },
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <span title={ROLE_LABEL[role as Role] ?? "Administrator (ingen andre kunne godkende)"} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 22, height: 22, padding: "0 5px",
      boxSizing: "border-box", borderRadius: 6, fontSize: 11, fontWeight: 700, ...(BADGE[role] ?? BADGE.I) }}>
      {role === "admin" ? "Admin" : role}
    </span>
  );
}

export const STATUS: Record<string, [string, string]> = {
  ok: ["OK", "green"], pending: ["Anmodning venter", "blue"], rotation_due: ["Rotation snart", "amber"],
  orphaned: ["Uden ansvarlig", "red"], archived: ["Arkiveret", ""],
};
export const REQ_STATUS: Record<string, [string, string]> = {
  pending: ["Afventer", "blue"], approved: ["Godkendt", "green"], rejected: ["Afvist", "red"], expired: ["Udløbet", ""], cancelled: ["Annulleret", ""],
};

/** Applies a click in the matrix: one A (moving it), I only for people without other roles. Returns an error text or null. */
export function toggleRole(raci: Raci, id: number, role: Role): [Raci, string | null] {
  const next: Raci = Object.fromEntries(Object.entries(raci).map(([k, v]) => [k, [...v]]));
  const cur = next[id] ?? [];
  if (role === "A") {
    if (cur.includes("A")) return [raci, "Der skal altid være én A. Giv A til en anden i stedet."];
    for (const k of Object.keys(next)) {
      const n = Number(k);
      if (n !== id && next[n].includes("A")) {
        next[n] = next[n].filter((r) => r !== "A");
        if (next[n].length === 0) next[n] = ["I"];
      }
    }
    next[id] = [...cur.filter((r) => r !== "I"), "A"];
  } else if (role === "I") {
    if (cur.some((r) => r !== "I")) return [raci, "I er for dem uden andre roller. Fjern R, A eller C først."];
    next[id] = cur.includes("I") ? [] : ["I"];
  } else {
    next[id] = cur.includes(role) ? cur.filter((r) => r !== role) : [...cur.filter((r) => r !== "I"), role];
  }
  return [next, null];
}

export function raciProblems(raci: Raci, people: Map<number, Person>): string[] {
  const out: string[] = [];
  const entries = Object.entries(raci).filter(([, v]) => v.length);
  if (entries.filter(([, v]) => v.includes("A")).length !== 1) out.push("Der skal være præcis én A.");
  if (!entries.some(([, v]) => v.includes("R"))) out.push("Der skal være mindst én R.");
  const bad = entries.filter(([k, v]) => v.some((r) => r !== "I") && !people.get(Number(k))?.eligible).map(([k]) => people.get(Number(k))?.name ?? `#${k}`);
  if (bad.length) out.push(`A, R og C skal være administratorer med adgang til Hemmeligheder: ${bad.join(", ")}.`);
  return out;
}

export function raciToBody(raci: Raci) {
  return Object.entries(raci).filter(([, v]) => v.length).map(([k, v]) => ({ user_id: Number(k), roles: v }));
}

/** The RACI matrix: one row per person (the group's members plus anyone added), one button per role. */
export function RaciEditor({ raci, onChange, rows, people }: {
  raci: Raci; onChange: (r: Raci) => void; rows: Person[]; people: Person[];
}) {
  const [warn, setWarn] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const shown = [...rows];
  for (const id of Object.keys(raci).map(Number)) {
    if (!shown.some((p) => p.id === id)) {
      const p = people.find((x) => x.id === id);
      if (p) shown.push(p);
    }
  }
  const candidates = people.filter((p) => !shown.some((s) => s.id === p.id));
  const click = (id: number, role: Role) => {
    const [next, err] = toggleRole(raci, id, role);
    setWarn(err);
    if (!err) onChange(next);
  };
  return (
    <div className="stack" style={{ "--gap": "10px" } as CSSProperties}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Person</th>{ROLES.map((r) => <th key={r} style={{ textAlign: "center" }} title={ROLE_LABEL[r]}>{r}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="small muted">{p.eligible ? p.email : "Kan kun være I (ikke admin med Hemmeligheder)"}</div>
                </td>
                {ROLES.map((r) => {
                  const on = (raci[p.id] ?? []).includes(r);
                  return (
                    <td key={r} style={{ textAlign: "center", padding: 6 }}>
                      <button type="button" aria-pressed={on} aria-label={`${ROLE_LABEL[r]} for ${p.name}`} onClick={() => click(p.id, r)}
                        disabled={r !== "I" && !p.eligible}
                        style={{ width: 40, height: 40, borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14,
                          ...(on ? { ...BADGE[r], border: BADGE[r].border ?? "1px solid transparent" } : { background: "#fff", color: "#94a3b8", border: "1px dashed #cbd5e1" }),
                          ...(r !== "I" && !p.eligible ? { opacity: 0.35, cursor: "not-allowed" } : {}) }}>
                        {on ? r : "·"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {candidates.length > 0 && (
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="field" style={{ flex: "1 1 260px" }}>Tilføj en administrator uden for gruppen
            <select value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">Vælg …</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.email ? ` · ${p.email}` : ""}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-outline btn-sm" disabled={!add} onClick={() => { onChange({ ...raci, [Number(add)]: ["C"] }); setAdd(""); }}>
            Tilføj som C
          </button>
        </div>
      )}
      {warn && <Alert kind="warn">{warn}</Alert>}
    </div>
  );
}

export function RequestCard({ r, onChange, showSecret }: { r: AccessRequest; onChange: () => void; showSecret?: boolean }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/admin/secrets/requests/${r.id}/decide`, { approve, note: note || null });
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await api.post(`/api/admin/secrets/requests/${r.id}/cancel`);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const who = r.grantee_group ? `gruppen ${r.grantee_group.name}` : r.grantee?.name ?? "—";
  const [label, tone] = REQ_STATUS[r.status] ?? [r.status, ""];
  return (
    <div className="card">
      <div className="spread">
        <div className="row" style={{ flexWrap: "wrap" }}>
          {showSecret && <Link to={`/secrets/${r.secret_id}`} style={{ fontWeight: 700 }}>{r.secret_name}{r.environment ? ` (${r.environment})` : ""}</Link>}
          <strong>{r.requester?.name ?? "Ukendt"}{r.own && " (dig)"}</strong>
          <span className="muted small">beder om</span>
          <span className="pill">{r.level_label}</span>
          <span className="muted small">til {who} i {r.days} {r.days === 1 ? "dag" : "dage"}</span>
          <span className={`pill ${tone}`}>{label}</span>
        </div>
        <span className="muted small">{fmtDate(r.created_at)}</span>
      </div>
      <div className="small">Begrundelse: „{r.reason}“</div>
      <div className="small muted">
        {r.rule_label} · {r.approved} af {r.total} har godkendt{r.status === "pending" && ` · udløber ${fmtDay(r.expires_at)}`}
      </div>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.approved} aria-label="Godkendelser">
        <div style={{ width: `${r.total ? (100 * r.approved) / r.total : 0}%` }} />
      </div>
      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        {r.approvals.map((a, i) => (
          <div key={i} className="row small" style={{ flexWrap: "wrap" }}>
            {a.roles.map((x) => <RoleBadge key={x} role={x} />)}
            <span style={{ fontWeight: 600 }}>{a.approver?.name ?? "Slettet bruger"}</span>
            <span className={`pill ${a.decision === "approved" ? "green" : a.decision === "rejected" ? "red" : "blue"}`}>
              {a.decision === "approved" ? "Godkendt" : a.decision === "rejected" ? "Afvist" : "Afventer"}
            </span>
            {a.decided_at && <span className="muted">{fmtDate(a.decided_at)}</span>}
            {a.note && <span className="muted">„{a.note}“</span>}
          </div>
        ))}
      </div>
      <Alert>{error}</Alert>
      {r.can_decide && (
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 260px" }}>Bemærkning (skal udfyldes ved afvisning)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => decide(false)}>Afvis</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(true)}>Godkend</button>
        </div>
      )}
      {r.can_decide && <p className="small muted">Du bekræfter med din passkey, sikkerhedsnøgle eller godkendelsesapp.</p>}
      {r.own && r.status === "pending" && <div className="row"><button className="btn btn-outline btn-sm" onClick={cancel}>Træk anmodningen tilbage</button></div>}
    </div>
  );
}
