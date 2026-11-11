// Choosing a secret from Hemmeligheder for an API source, and asking its A, R and C for "Brug i kilde"
// (GET /api/admin/data/secrets, POST /api/admin/data/sources/:id/secret-requests). Names and status only: never a value.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound, Plus, Send } from "lucide-react";
import { Btn, CloseBtn, Drawer, ErrorBox, fmtDay } from "../../../ui";
import { input, sectionLabel, select } from "../../../theme";
import { RoleBadge } from "../../secrets/shared";
import { srOnly } from "../types";

type Person = { id: number; name: string; email: string | null; eligible: boolean };
export type SecretItem = {
  id: number; ref: string; name: string; environment: string; description: string; group: { id: number; name: string; slug: string };
  version: number; value_changed_at: string | null; rotation_days: number | null; expires_at: string | null; status: string;
  rule: string; rule_label: string; accountable: Person | null; approvers: (Person & { roles: string[] })[];
  my_roles: string[]; my_level: "read" | "write" | null;
  source_grant: { id: number; expires_at: string } | null;
  source_request: { id: number; approved: number; total: number; expires_at: string } | null;
};

export type Tone = { bg: string; fg: string; label: string };
const T = {
  green: { bg: "rgba(22,163,74,0.12)", fg: "#166534" },
  orange: { bg: "rgba(249,115,22,0.12)", fg: "#9a3412" },
  blue: { bg: "#eff6ff", fg: "#1d4ed8" },
  gray: { bg: "#f1f5f9", fg: "#475569" },
  red: { bg: "rgba(220,38,38,0.1)", fg: "#b91c1c" },
};

/** What a secret means for this source right now. */
export function secretState(s: SecretItem | undefined, saved: boolean): Tone & { usable: boolean; testable: boolean } {
  if (!s) return { ...T.red, label: "Findes ikke i Hemmeligheder", usable: false, testable: false };
  if (s.status === "orphaned") return { ...T.red, label: "Uden ansvarlig (A) · kan ikke godkendes", usable: false, testable: !!s.my_level };
  if (s.source_grant) return { ...T.green, label: `Kilden har adgang · til ${fmtDay(s.source_grant.expires_at)}`, usable: true, testable: true };
  if (s.source_request) return { ...T.orange, label: `Afventer godkendelse · ${s.source_request.approved} af ${s.source_request.total}`, usable: false, testable: !!s.my_level };
  if (s.my_level) return { ...T.blue, label: saved ? "Du kan teste · kilden mangler adgang" : "Du kan teste med din egen adgang", usable: false, testable: true };
  return { ...T.gray, label: "Ingen adgang endnu", usable: false, testable: false };
}

export function rotationLabel(s: SecretItem): string | null {
  if (!s.rotation_days || !s.value_changed_at) return null;
  const due = new Date(s.value_changed_at).getTime() + s.rotation_days * 86_400_000;
  const days = Math.round((due - Date.now()) / 86_400_000);
  return days < 0 ? `Rotation overskredet med ${-days} dage` : `Rotation om ${days} dage`;
}

export default function SecretPicker({ title, current, items, sourceSaved, onPick, onRequest, onClose }: {
  title: string; current: string | null; items: SecretItem[]; sourceSaved: boolean;
  onPick: (ref: string) => void; onRequest: (s: SecretItem, days: number, reason: string) => Promise<void>; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [days, setDays] = useState(365);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => [...new Map(items.map((s) => [s.group.id, s.group])).values()], [items]);
  const shown = items.filter((s) => (!group || String(s.group.id) === group)
    && (!q.trim() || `${s.ref} ${s.description}`.toLowerCase().includes(q.trim().toLowerCase())));

  const send = async (s: SecretItem) => {
    setBusy(true);
    setError(null);
    try {
      await onRequest(s, days, reason);
      setOpen(null);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer width={620} onClose={onClose} label="Vælg hemmelighed">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "18px 20px 12px", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Vælg hemmelighed til {title}</h2>
          <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
            Kilden gemmer kun navnet. Når hemmelighedens A, R og C har godkendt <strong>Brug i kilde</strong>, sætter serveren værdien ind i kaldet. Ingen
            person kan se den gennem den adgang.
          </p>
        </div>
        <CloseBtn onClick={onClose} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 20px" }}>
        <label style={{ display: "flex", flex: "1 1 220px" }}>
          <span style={srOnly}>Find hemmelighed</span>
          <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find navn eller gruppe" style={{ ...input, width: "100%" }} />
        </label>
        <label style={{ display: "flex" }}>
          <span style={srOnly}>Gruppe</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={select}>
            <option value="">Alle grupper</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      </div>
      <div style={{ flex: 1, overflowY: "auto", borderTop: "1px solid #e2e8f0" }}>
        {shown.length === 0 && <p style={{ padding: 20, margin: 0, color: "#64748b", fontSize: 13 }}>Ingen hemmeligheder matcher. Opret den i Hemmeligheder.</p>}
        {shown.map((s) => {
          const st = secretState(s, sourceSaved);
          const chosen = current?.toLowerCase() === s.ref.toLowerCase();
          const rot = rotationLabel(s);
          const canAsk = !s.source_grant && !s.source_request && s.status !== "orphaned";
          return (
            <div key={s.id} style={{ borderBottom: "1px solid #f1f5f9", background: chosen ? "#f8fbff" : "#ffffff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", flexWrap: "wrap" }}>
                <KeyRound size={16} color="#64748b" aria-hidden />
                <span style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <code style={{ fontSize: 13.5, fontWeight: 600 }}>{s.ref}</code>
                    {s.my_roles.map((r) => <RoleBadge key={r} role={r} />)}
                  </span>
                  <span style={{ fontSize: 12, color: "#475569" }}>
                    {s.group.name} · version {s.version} · A: {s.accountable?.name ?? "ingen"} · {s.rule_label}{rot ? ` · ${rot}` : ""}
                  </span>
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 9999, background: st.bg, color: st.fg }}>{st.label}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  {canAsk && <Btn height={32} onClick={() => setOpen(open === s.id ? null : s.id)}>Anmod</Btn>}
                  <Btn kind={chosen ? "outline" : "primary"} height={32} disabled={s.status === "orphaned"} onClick={() => onPick(s.ref)}>{chosen ? "Valgt" : "Brug"}</Btn>
                </span>
              </div>
              {open === s.id && (
                <form onSubmit={(e) => { e.preventDefault(); send(s); }}
                  style={{ margin: "0 20px 14px", padding: 14, border: "1px solid #bfdbfe", background: "#f8fbff", borderRadius: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Anmod om Brug i kilde for <code>{s.ref}</code></span>
                  {!sourceSaved && <span style={{ fontSize: 12, color: "#9a3412" }}>Kilden gemmes med hemmeligheden først, så godkenderne kan se, hvilke værter værdien sendes til.</span>}
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 500 }}>Udløber
                      <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={select}>
                        {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d === 365 ? "Om 1 år (højst)" : `Om ${d} dage`}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 500, flex: "1 1 260px" }}>Begrundelse
                      <textarea required minLength={3} maxLength={800} rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder="Hvad skal kilden bruges til?" style={{ ...input, height: "auto", padding: "8px 10px", resize: "vertical" }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                    <span style={sectionLabel}>Godkendes af</span>
                    {s.approvers.length === 0 && <span>én anden administrator (der er ingen andre i A, R og C)</span>}
                    {s.approvers.map((a) => (
                      <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 9999, background: "#ffffff", border: "1px solid #e2e8f0" }}>
                        {a.roles.map((r) => <RoleBadge key={r} role={r} />)}{a.name}
                      </span>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: "#475569" }}>Du kan ikke godkende selv. Én afvisning lukker anmodningen, og den udløber efter 7 dage.</span>
                  {error && <ErrorBox>{error}</ErrorBox>}
                  <div><Btn kind="primary" type="submit" icon={Send} disabled={busy || reason.trim().length < 3}>Brug og send anmodning</Btn></div>
                </form>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: "12px 20px", borderTop: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
        <Link to="/secrets" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}><Plus size={14} />Opret ny hemmelighed i Hemmeligheder</Link>
      </div>
    </Drawer>
  );
}
