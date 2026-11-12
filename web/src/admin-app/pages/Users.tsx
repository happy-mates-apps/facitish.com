// /admin/users → Brugere og roller (screen 02). Clicking a row opens the user full screen (UserEdit, ?user=<id>);
// "Opret bruger" creates a user without them signing up (needed when sign-up is closed, /admin/settings → Tilmelding).
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { api, errorText } from "../../api";
import { useAuth } from "../../auth";
import { Btn, Empty, ErrorBox, Modal, PageTitle, Pill, useLoad, useToast } from "../ui";
import { card, SANS, tableHead } from "../theme";
import { factorCount, isTest, userView, type AdminRole, type AdminUser, type UsersResponse } from "../users";
import UserEdit from "./UserEdit";

const FILTERS: [key: string, label: string, test: (u: AdminUser) => boolean][] = [
  ["all", "Alle", () => true],
  ["active", "Aktive", (u) => !u.blocked_at],
  ["blocked", "Spærrede", (u) => !!u.blocked_at],
  ["nopk", "Uden passkey", (u) => u.passkeys === 0 && !isTest(u)],
  ["admins", "Admins", (u) => u.role === "admin"],
  ["adminnomfa", "Admins uden MFA", (u) => u.role === "admin" && !isTest(u) && factorCount(u) === 0],
  ["yubikey", "Kræver YubiKey", (u) => !!u.yubikey_required],
  ["test", "Testkonti", isTest],
];
const COLS = "minmax(240px,1.6fr) 110px 170px 130px 100px 40px";

export default function Users() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const { data, error, reload } = useLoad(() => api.get<UsersResponse>("/api/admin/users?limit=500"), []);
  const { data: signup } = useLoad(() => api.get<{ mode: "open" | "domains" | "closed" }>("/api/admin/settings/signup").catch(() => null), []);
  const [creating, setCreating] = useState(false);
  const filter = params.get("filter") ?? "all";
  const selected = Number(params.get("user") ?? params.get("userId")) || null;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (key === "user") next.delete("userId");
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === "filter" });
  };

  const users = data?.items ?? [];
  const grace = data?.grace_logins ?? 3;
  const fn = (FILTERS.find((f) => f[0] === filter) ?? FILTERS[0])[2];
  const needle = q.trim().toLowerCase().replace(/^\+?45\s?/, "");
  const rows = users.filter(fn).filter((u) => !needle || `${u.display_name ?? ""} ${u.email ?? ""} ${u.phone ?? ""}`.toLowerCase().replace(/\s/g, "").includes(needle.replace(/\s/g, "")));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="Brugere og roller" aside={<Btn kind="primary" icon={Plus} height={40} onClick={() => setCreating(true)}>Opret bruger</Btn>}>
        Den første bruger på en ny instans bliver admin. Der skal altid være mindst én admin. Alt her skrives i audit-loggen.
        {signup && <> Tilmelding: <Link to="/settings#tilmelding">{signup.mode === "open" ? "åben" : signup.mode === "domains" ? "kun bestemte domæner" : "lukket"}</Link>.</>}
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søg på navn eller telefonnummer"
            style={{ flex: "1 1 240px", minWidth: 0, height: 34, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: `14px ${SANS}`, boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {FILTERS.map(([key, label, f]) => {
              const on = filter === key;
              return (
                <button key={key} type="button" onClick={() => setParam("filter", key === "all" ? null : key)}
                  style={{ cursor: "pointer", height: 28, padding: "0 10px", borderRadius: 9999, border: `1px solid ${on ? "#0f172a" : "#e2e8f0"}`,
                    background: on ? "#0f172a" : "#ffffff", color: on ? "#ffffff" : "#475569", font: `500 12px ${SANS}`, whiteSpace: "nowrap" }}>
                  {label} · {users.filter(f).length}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 860 }}>
            <div style={{ ...tableHead, gridTemplateColumns: COLS }}>
              <span>Bruger</span><span>Rolle</span><span>Login</span><span>Sidst logget ind</span><span>Status</span><span />
            </div>
            {rows.map((u) => {
              const v = userView(u, grace);
              return (
                <div key={u.id} role="button" tabIndex={0} className="tg-row" onClick={() => setParam("user", String(u.id))}
                  onKeyDown={(e) => e.key === "Enter" && setParam("user", String(u.id))}
                  style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center", padding: "9px 16px", borderBottom: "1px solid #f1f5f9",
                    fontSize: 13, cursor: "pointer", background: selected === u.id ? "#f8fafc" : "#ffffff" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 30, height: 30, flex: "none", borderRadius: 9999, background: v.avatar, color: "#ffffff", display: "flex",
                      alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>{v.initials}</span>
                    <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</span>
                        {isTest(u) && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 9999, background: "rgba(245,158,11,0.15)", color: "#92400e" }}>Testkonto</span>}
                      </span>
                      <span style={{ fontSize: 12, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{v.sub}</span>
                    </span>
                  </span>
                  <span><Pill tone={v.role[1]}>{v.role[0]}</Pill></span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
                    <Pill tone={v.login[1]}>{v.login[0]}</Pill>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{v.sessions}</span>
                  </span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>{v.last}</span>
                  <span><Pill tone={v.status[1]}>{v.status[0]}</Pill></span>
                  <ChevronRight size={16} color="#94a3b8" strokeWidth={2} />
                </div>
              );
            })}
            {data && rows.length === 0 && <Empty>Ingen brugere matcher.</Empty>}
          </div>
        </div>
        <div style={{ padding: "10px 16px", fontSize: 12, color: "#64748b" }}>{rows.length} af {users.length} brugere</div>
      </div>
      {selected && <UserEdit key={selected} userId={selected} users={users} grace={grace} roles={data?.admin_roles ?? []}
        onClose={() => setParam("user", null)} onChanged={reload} />}
      {creating && <CreateUser roles={data?.admin_roles ?? []} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); reload(); setParam("user", String(id)); }} />}
    </div>
  );
}


/** Opret bruger: the user logs in with the e-mail and a code (no password). An admin needs full access; creating an
 * admin or a user with the YubiKey requirement asks for a step-up (handled by api.ts). */
function CreateUser({ roles, onClose, onCreated }: { roles: AdminRole[]; onClose: () => void; onCreated: (id: number) => void }) {
  const { user: me } = useAuth();
  const say = useToast();
  const full = !!me?.super_admin || !!me?.admin_roles.includes("fuld");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [picked, setPicked] = useState<string[]>(["fuld"]);
  const [yubikey, setYubikey] = useState(false);
  const [welcome, setWelcome] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = { height: 40, padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: 8, font: `400 14px ${SANS}`, boxSizing: "border-box" as const, width: "100%" };
  const field = { display: "flex", flexDirection: "column" as const, gap: 6, fontSize: 14, fontWeight: 600 };
  const choice = (on: boolean, locked = false) => ({
    display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, fontSize: 14, flex: "1 1 200px",
    border: on ? "2px solid #2563eb" : "1px solid #e2e8f0", background: on ? "#eff6ff" : "#ffffff", cursor: locked ? "default" : "pointer", opacity: locked ? 0.6 : 1,
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: number; welcome_sent: boolean | null }>("/api/admin/users", {
        email: email.trim(), display_name: name.trim() || null, phone: phone.trim() || null, role,
        admin_roles: role === "admin" ? picked : [], yubikey_required: yubikey, send_welcome: welcome,
      });
      say(r.welcome_sent === false ? "Brugeren er oprettet, men velkomstmailen kunne ikke sendes" : role === "admin" ? "Admin oprettet" : "Bruger oprettet");
      onCreated(r.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal width={560} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <strong style={{ fontSize: 19 }}>Opret bruger</strong>
          <span style={{ color: "#475569", fontSize: 14 }}>Brugeren logger ind med sin e-mail og en engangskode. Der er ingen adgangskode.</span>
        </div>
        <label style={field}>E-mail
          <input style={input} type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="navn@firma.dk" />
        </label>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...field, flex: "1 1 200px" }}>Navn
            <input style={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ ...field, flex: "1 1 200px" }}>Telefon <span style={{ fontWeight: 400, color: "#64748b" }}>(valgfri)</span>
            <input style={input} type="tel" value={phone} placeholder="+45" onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ fontWeight: 600, fontSize: 14, padding: "0 0 6px" }}>Rolle</legend>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={choice(role === "user")}>
              <input type="radio" name="role" checked={role === "user"} onChange={() => setRole("user")} style={{ marginTop: 3 }} />
              <span><strong>Bruger</strong><br /><span style={{ fontSize: 13, color: "#475569" }}>Appen, ikke /admin</span></span>
            </label>
            <label style={choice(role === "admin", !full)}>
              <input type="radio" name="role" checked={role === "admin"} disabled={!full} onChange={() => setRole("admin")} style={{ marginTop: 3 }} />
              <span><strong>Admin</strong><br /><span style={{ fontSize: 13, color: "#475569" }}>{full ? "Kun de dele af /admin du vælger" : "Kræver fuld adgang"}</span></span>
            </label>
          </div>
          {role === "admin" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 4 }}>
              {roles.map((r) => {
                const on = picked.includes(r.key);
                return (
                  <label key={r.key} title={r.description} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 32, padding: "0 10px", borderRadius: 999,
                    border: `1px solid ${on ? "#93c5fd" : "#e2e8f0"}`, background: on ? "#eff6ff" : "#ffffff", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((k) => k !== r.key) : [...picked, r.key])} />{r.label}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <label style={{ ...choice(yubikey), flex: "none", background: yubikey ? "#eff6ff" : "#f8fafc" }}>
          <input type="checkbox" checked={yubikey} onChange={(e) => setYubikey(e.target.checked)} style={{ marginTop: 3 }} />
          <span><strong>Kræv YubiKey til /admin</strong><br /><span style={{ fontSize: 13, color: "#475569" }}>
            Ingen adgang til /admin og andre beskyttede områder, før en YubiKey er tilknyttet. Passkeys og apps tæller ikke.</span></span>
        </label>
        <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={welcome} onChange={(e) => setWelcome(e.target.checked)} />
          Send en velkomstmail med link til login
        </label>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
          {(role === "admin" || yubikey) && <span style={{ marginRight: "auto", fontSize: 13, color: "#475569" }}>Kræver at du bekræfter med din egen nøgle</span>}
          <Btn height={40} onClick={onClose}>Annullér</Btn>
          <Btn kind="primary" type="submit" height={40} disabled={busy || !email.trim() || (role === "admin" && picked.length === 0)}>
            {busy ? "Opretter …" : role === "admin" ? "Opret admin" : "Opret bruger"}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
