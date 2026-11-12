// /admin/users?user=<id> — editing one user full screen (replaces the drawer, screen 03). Profile, access and the
// YubiKey requirement are a form saved with one Save (PUT /api/admin/users/{id}, all or nothing; a step-up is asked
// for when a security field changed). Blocking, logging out, resetting keys, login links and YubiKey enrolment act
// at once and are not part of Save. Deep links keep their anchors (data-deeplink user-drawer, user-role …).
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { ArrowLeft, Ban, Check, KeyRound, LockOpen, LogOut, Mail, ScrollText, ShieldAlert, Usb } from "lucide-react";
import { api, errorText } from "../../api";
import { passkeyErrorText, useAuth } from "../../auth";
import { useAdmin } from "../context";
import { dateLabel, lastLabel, phoneLabel, RING, SANS } from "../theme";
import { Btn, ErrorBox, Loading, Modal, Pill, useToast } from "../ui";
import { userView, type AdminRole, type AdminUser } from "../users";

type Key = {
  id: number; name: string; kind: "passkey" | "security_key"; yubikey: boolean; attestation: "verified" | "issuer" | null;
  enrolled_by: number | null; enrolled_by_name: string | null; created_at: string; last_used_at: string | null;
};
type Detail = {
  user: AdminUser & {
    locale: string | null; time_zone: string | null; updated_at: string; mfa_required: boolean; yubikey_required: boolean;
    created_by: number | null; created_by_name: string | null;
  };
  security: {
    factors: { passkeys: number; security_keys: number; totp: number; yubikeys: number; total: number };
    keys: Key[];
    totp: { id: number; name: string; created_at: string; last_used_at: string | null }[];
    grace_logins: number; grace_left: number | null; yubikey_required: boolean; yubikey_attestation: "verified" | "issuer";
  };
  sessions: { id: number; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; mfa_at: string | null }[];
};
type Form = {
  display_name: string; email: string; phone: string; audience: "internal" | "external"; role: "user" | "admin";
  admin_roles: string[]; yubikey_required: boolean;
};

const fromDetail = (d: Detail): Form => ({
  display_name: d.user.display_name ?? "", email: d.user.email ?? "", phone: d.user.phone ?? "",
  audience: d.user.audience, role: d.user.role, admin_roles: [...(d.user.admin_roles ?? [])].sort(),
  yubikey_required: d.user.yubikey_required,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SECTIONS = [
  ["profil", "Profil"], ["adgang", "Adgang"], ["sikkerhed", "Sikkerhed"], ["sessioner", "Sessioner"], ["spaer", "Spær"],
] as const;

const box: CSSProperties = { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 16, scrollMarginTop: 96 };
const h2: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600 };
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 };
const inputStyle: CSSProperties = { height: 40, padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: 8, font: `400 14px ${SANS}`, boxSizing: "border-box", width: "100%" };
const hint: CSSProperties = { fontSize: 13, fontWeight: 400, color: "#475569" };
const choice = (on: boolean, locked = false): CSSProperties => ({
  display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, fontSize: 14,
  border: on ? "2px solid #2563eb" : "1px solid #e2e8f0", background: on ? "#eff6ff" : "#ffffff",
  cursor: locked ? "default" : "pointer", opacity: locked && !on ? 0.6 : 1,
});

function Changed() {
  return <span style={{ display: "inline-flex", height: 22, alignItems: "center", padding: "0 8px", borderRadius: 999, background: "#dbeafe", color: "#1d4ed8", fontSize: 12, fontWeight: 600 }}>Ændret</span>;
}

function Section({ id, title, changed, children, deeplink, danger, aside }: {
  id: string; title: string; changed?: boolean; children: ReactNode; deeplink?: string; danger?: boolean; aside?: ReactNode;
}) {
  return (
    <section id={`bruger-${id}`} data-deeplink={deeplink} style={{ ...box, ...(danger ? { borderColor: "#fecaca" } : {}) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ ...h2, ...(danger ? { color: "#b91c1c" } : {}) }}>{title}</h2>
        {changed && <Changed />}
        {aside && <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export default function UserEdit({ userId, users, roles, grace, onClose, onChanged }: {
  userId: number; users: AdminUser[]; roles: AdminRole[]; grace: number; onClose: () => void; onChanged: () => void;
}) {
  const { user: me } = useAuth();
  const { impersonating, refreshImpersonation } = useAdmin();
  const navigate = useNavigate();
  const say = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"yubikey" | "recover" | null>(null);

  // keep: an action that acts at once (block, reset, YubiKey …) reloads the facts but keeps unsaved edits.
  const load = useCallback(async (keep = false) => {
    try {
      const d = await api.get<Detail>(`/api/admin/users/${userId}`);
      setDetail(d);
      setForm((prev) => (keep && prev ? prev : fromDetail(d)));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  const initial = useMemo(() => (detail ? fromDetail(detail) : null), [detail]);
  const changes = useMemo(() => {
    if (!form || !initial) return {} as Partial<Form>;
    const out: Partial<Form> = {};
    (Object.keys(form) as (keyof Form)[]).forEach((k) => {
      if (!same(k === "admin_roles" ? [...form.admin_roles].sort() : form[k], initial[k])) (out as Record<string, unknown>)[k] = form[k];
    });
    if (out.role === "user") delete out.admin_roles;
    if (out.phone === "") delete out.phone; // the phone number is corrected, not removed, here
    return out;
  }, [form, initial]);
  const dirty = Object.keys(changes).length;

  const close = useCallback(() => {
    if (dirty && !confirm("Du har ændringer, der ikke er gemt. Luk uden at gemme?")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !dialog && close();
    const onUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onUnload); };
  }, [close, dirty, dialog]);

  // The page behind does not scroll while this one is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const save = async () => {
    if (!dirty) return;
    if (changes.audience === "external" && !confirm("Gør brugeren ekstern? Interne adgange og anmodninger ophører med det samme.")) return;
    setSaving(true);
    try {
      const d = await api.put<Detail>(`/api/admin/users/${userId}`, changes);
      setDetail(d);
      setForm(fromDetail(d));
      say("Ændringerne er gemt");
      onChanged();
    } catch (e) {
      say(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const act = (call: () => Promise<unknown>, done: string) => async () => {
    try {
      await call();
      say(done);
      await load(true);
      onChanged();
    } catch (e) {
      say(errorText(e));
    }
  };

  if (!detail || !form) {
    return (
      <Shell>
        <div style={{ padding: 32 }}>{error ? <ErrorBox>{error}</ErrorBox> : <Loading />}</div>
      </Shell>
    );
  }

  const u = detail.user;
  const sec = detail.security;
  const v = userView({ ...u, passkeys: sec.factors.passkeys + sec.factors.security_keys, totp: sec.factors.totp, active_sessions: detail.sessions.length, yubikeys: sec.factors.yubikeys }, grace);
  const test = !!u.impersonation_only;
  const isMe = u.id === me?.id;
  const full = !!me?.super_admin || !!me?.admin_roles.includes("fuld");
  const sup = !!u.super_admin;
  const lastAdmin = users.filter((x) => x.role === "admin" && !x.impersonation_only && !x.blocked_at).length <= 1 && u.role === "admin";
  const canResetKeys = !isMe && !test && (u.role !== "admin" || !!me?.super_admin);
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setForm({ ...form, [k]: value });
  const toggleRole = (key: string) =>
    set("admin_roles", form.admin_roles.includes(key) ? form.admin_roles.filter((r) => r !== key) : [...form.admin_roles, key].sort());
  const ring = u.feature_ring;
  const active = impersonating?.id === u.id;

  const header = (
    <header style={{ position: "sticky", top: 0, zIndex: 2, background: "#ffffff", borderBottom: "1px solid #e2e8f0", padding: "12px 24px",
      display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
      <Btn kind="ghost" icon={ArrowLeft} height={40} onClick={close}>Brugere</Btn>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "1 1 280px", minWidth: 0 }}>
        <span style={{ width: 40, height: 40, flex: "none", borderRadius: 9999, background: v.avatar, color: "#ffffff", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 14, fontWeight: 700 }}>{v.initials}</span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</h1>
          <span style={{ fontSize: 13, color: "#64748b" }}>
            {v.sub} · oprettet {dateLabel(u.created_at)}{u.created_by ? ` af ${u.created_by_name || `#${u.created_by}`}` : test ? "" : " ved login"}
          </span>
        </div>
      </div>
      {!test && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {dirty > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#1d4ed8", fontWeight: 500, fontSize: 14 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: "#2563eb" }} />
              {dirty} {dirty === 1 ? "ændring" : "ændringer"} ikke gemt
            </span>
          )}
          <Btn height={40} disabled={!dirty || saving} onClick={() => setForm(fromDetail(detail))}>Fortryd</Btn>
          <Btn kind="primary" icon={Check} height={40} disabled={!dirty || saving} onClick={save}>{saving ? "Gemmer …" : "Gem ændringer"}</Btn>
        </div>
      )}
    </header>
  );

  return (
    <Shell deeplink="user-drawer" label={`Rediger ${v.name}`}>
      {header}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 32, padding: 32, maxWidth: 1200, margin: "0 auto", boxSizing: "border-box", width: "100%" }}>
        <nav aria-label="Afsnit" style={{ flex: "1 1 180px", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 2, alignSelf: "flex-start", position: "sticky", top: 88 }}>
          {SECTIONS.filter(([id]) => !test || id === "profil").map(([id, label]) => (
            <a key={id} href={`#bruger-${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`bruger-${id}`)?.scrollIntoView({ behavior: "smooth" }); }}
              style={{ minHeight: 36, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", borderRadius: 8, color: "#334155", textDecoration: "none", fontSize: 14 }}>
              {label}
              {((id === "profil" && ("display_name" in changes || "email" in changes || "phone" in changes || "audience" in changes))
                || (id === "adgang" && ("role" in changes || "admin_roles" in changes))
                || (id === "sikkerhed" && "yubikey_required" in changes)) && <span style={{ width: 8, height: 8, borderRadius: 999, background: "#2563eb" }} />}
            </a>
          ))}
          <a href={`/admin/logs/auth?user_id=${u.id}`} onClick={(e) => { e.preventDefault(); if (!dirty || confirm("Forlad siden uden at gemme?")) navigate(`/logs/auth?user_id=${u.id}`); }}
            style={{ minHeight: 36, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderRadius: 8, color: "#334155", textDecoration: "none", fontSize: 14 }}>
            <ScrollText size={15} /> Auth-log
          </a>
        </nav>

        <main style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          {test && (
            <div style={{ padding: "12px 14px", borderRadius: 12, background: "#fffbeb", border: "1px solid rgba(245,158,11,0.35)", display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#78350f" }}>
              <span style={{ flex: 1 }}>Testkonto. Kan kun bruges gennem efterligning og redigeres ikke her.</span>
              <Btn kind="dark" onClick={async () => {
                try {
                  if (active) await api.post("/api/impersonation/stop");
                  else await api.post("/api/impersonation/start", { user_id: u.id });
                  say(active ? "Efterligning stoppet" : `Efterligner ${v.name}. Appen på / viser nu testkontoen.`);
                  await refreshImpersonation();
                } catch (e) { say(errorText(e)); }
              }}>{active ? "Stop efterligning" : "Skift til"}</Btn>
            </div>
          )}

          <Section id="profil" title="Profil" deeplink="user-profile" changed={"display_name" in changes || "email" in changes || "phone" in changes || "audience" in changes}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
              <label style={field}>Navn
                <input style={inputStyle} value={form.display_name} disabled={test} onChange={(e) => set("display_name", e.target.value)} />
              </label>
              <label style={field}>E-mail
                <input style={inputStyle} type="email" value={form.email} disabled={test} onChange={(e) => set("email", e.target.value)} />
                <span style={hint}>Ændres e-mailen, logges brugeren ud alle steder.</span>
              </label>
              <label style={field}>Telefon
                <input style={inputStyle} type="tel" value={form.phone} placeholder="+45" disabled={test} onChange={(e) => set("phone", e.target.value)} />
                {u.phone && <span style={hint}>Nu: {phoneLabel(u.phone)}</span>}
              </label>
              {!test && (
                <fieldset data-deeplink="user-audience" style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 0 6px" }}>Brugertype</legend>
                  <div style={{ display: "flex", gap: 8 }}>
                    {([["internal", "Intern"], ["external", "Ekstern"]] as const).map(([key, label]) => (
                      <label key={key} style={{ ...choice(form.audience === key), flex: 1, alignItems: "center", minHeight: 40, padding: "0 12px" }}>
                        <input type="radio" name="audience" checked={form.audience === key} onChange={() => set("audience", key)} />{label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#475569" }}>
              <span>Sidst logget ind: {lastLabel(u.last_login_at)}</span>
              <span>Feature-niveau: {ring ? `Ring ${ring} · ${RING[ring][0]}` : "Ring 4 · standard"}</span>
            </div>
          </Section>

          {!test && (
            <Section id="adgang" title="Adgang" deeplink="user-role" changed={"role" in changes || "admin_roles" in changes}>
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 0 6px" }}>Rolle</legend>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {([["user", "Bruger", "Appen, ikke /admin"], ["admin", "Admin", "De dele af /admin, der er valgt herunder"]] as const).map(([key, label, sub]) => {
                    const locked = !full || (key === "user" && (sup || lastAdmin));
                    return (
                      <label key={key} style={{ ...choice(form.role === key, locked), flex: "1 1 220px" }}>
                        <input type="radio" name="role" checked={form.role === key} disabled={locked} onChange={() => set("role", key)} style={{ marginTop: 3 }} />
                        <span><strong>{label}</strong><br /><span style={hint}>{sub}</span></span>
                      </label>
                    );
                  })}
                </div>
                {!full && <span style={hint}>Kun admins med fuld adgang kan ændre, hvem der er admin.</span>}
                {full && sup && <span style={hint}>Superadministratoren er altid admin med fuld adgang.</span>}
                {full && !sup && lastAdmin && <span style={hint}>Der skal altid være mindst én admin.</span>}
              </fieldset>
              {form.role === "admin" && (
                <fieldset data-deeplink="user-admin-roles" style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 0 6px" }}>Admin-roller</legend>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
                    {roles.map((r) => {
                      const on = form.admin_roles.includes(r.key);
                      const locked = !full || (r.key === "fuld" && sup);
                      return (
                        <label key={r.key} style={choice(on, locked)}>
                          <input type="checkbox" checked={on} disabled={locked} onChange={() => toggleRole(r.key)} style={{ marginTop: 3 }} />
                          <span><strong>{r.label}</strong>{on && !(initial?.admin_roles ?? []).includes(r.key) && <span style={{ color: "#1d4ed8", fontSize: 12, fontWeight: 600 }}> · ny</span>}
                            <br /><span style={hint}>{r.description}</span></span>
                        </label>
                      );
                    })}
                  </div>
                  {form.admin_roles.length === 0 && u.role === "admin" && <span style={{ ...hint, color: "#b91c1c" }}>Vælg mindst én rolle.</span>}
                </fieldset>
              )}
            </Section>
          )}

          {!test && (
            <Section id="sikkerhed" title="Sikkerhed" deeplink="user-mfa" changed={"yubikey_required" in changes}
              aside={<>
                <Btn icon={Mail} height={40} onClick={() => setDialog("recover")} disabled={!!u.blocked_at}>Gendan adgang</Btn>
                <Btn icon={Usb} height={40} onClick={() => setDialog("yubikey")} disabled={isMe || !!u.blocked_at}
                  style={{ borderColor: "#2563eb", color: "#1d4ed8" }}>Tilknyt YubiKey</Btn>
              </>}>
              <label style={{ ...choice(form.yubikey_required), padding: 16, gap: 14 }}>
                <input type="checkbox" role="switch" checked={form.yubikey_required} onChange={(e) => set("yubikey_required", e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 2, accentColor: "#2563eb" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <strong>Kræv YubiKey til beskyttede områder</strong>
                  <span style={{ ...hint, color: "#334155" }}>
                    Kun en tilknyttet YubiKey tæller som andet trin i /admin, ved bekræftelse af admin-handlinger, visning af hemmeligheder,
                    efterligning og MCP admin-adgang. Passkeys og godkendelsesapps virker stadig i resten af appen. Ingen logins med engangskode til /admin.
                  </span>
                  {form.yubikey_required && sec.factors.yubikeys === 0 && (
                    <span style={{ ...hint, color: "#92400e" }}>Brugeren har ingen YubiKey endnu og kommer ikke ind i /admin, før en er tilknyttet.</span>
                  )}
                </span>
              </label>

              <div style={{ display: "flex", flexDirection: "column", border: "1px solid #e2e8f0", borderRadius: 12 }}>
                {sec.keys.length === 0 && sec.totp.length === 0 && <div style={{ padding: 16, color: "#475569", fontSize: 14 }}>Ingen nøgler eller apps. Brugeren logger ind med engangskode.</div>}
                {sec.keys.map((k, i) => (
                  <div key={k.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, padding: "14px 16px", borderTop: i ? "1px solid #e2e8f0" : 0 }}>
                    <span style={{ width: 40, height: 40, borderRadius: 10, flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
                      background: k.yubikey ? "#ecfdf5" : "#f1f5f9", color: k.yubikey ? "#15803d" : "#475569" }}>
                      {k.kind === "security_key" ? <Usb size={20} /> : <KeyRound size={20} />}
                    </span>
                    <span style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 2 }}>
                      <strong style={{ fontSize: 14 }}>{k.name}</strong>
                      <span style={{ fontSize: 13, color: "#475569" }}>
                        {k.yubikey ? (k.attestation === "verified" ? "YubiKey, bekræftet mod Yubico" : "YubiKey") : k.kind === "security_key" ? "Sikkerhedsnøgle" : "Passkey"}
                        {" · "}{k.enrolled_by ? `tilknyttet af ${k.enrolled_by_name || `#${k.enrolled_by}`}` : "tilføjet af brugeren"} {dateLabel(k.created_at)}
                        {" · "}{k.last_used_at ? `sidst brugt ${lastLabel(k.last_used_at)}` : "aldrig brugt"}
                      </span>
                    </span>
                    <Pill tone={k.yubikey ? "green" : "gray"}>{k.yubikey ? "Tæller til /admin" : form.yubikey_required ? "Kun appen" : "Andet trin"}</Pill>
                  </div>
                ))}
                {sec.totp.map((t) => (
                  <div key={`t${t.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, padding: "14px 16px", borderTop: "1px solid #e2e8f0" }}>
                    <span style={{ width: 40, height: 40, borderRadius: 10, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", color: "#475569" }}>
                      <ShieldAlert size={20} />
                    </span>
                    <span style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 2 }}>
                      <strong style={{ fontSize: 14 }}>{t.name}</strong>
                      <span style={{ fontSize: 13, color: "#475569" }}>Godkendelsesapp · {t.last_used_at ? `sidst brugt ${lastLabel(t.last_used_at)}` : "aldrig brugt"}</span>
                    </span>
                    <Pill tone="gray">{form.yubikey_required ? "Kun appen" : "Andet trin"}</Pill>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#475569" }}>
                <span>Kræv passkey (brugerens eget valg): {u.mfa_required ? "til" : "fra"}</span>
                {u.role === "admin" && !form.yubikey_required && sec.grace_left !== null && <span>Logins med engangskode til /admin: {sec.grace_left} af {sec.grace_logins} tilbage</span>}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn icon={ShieldAlert} height={40} deeplink="user-mfa" disabled={!canResetKeys || (!sec.factors.total && !u.mfa_required)}
                  title={isMe ? "Dine egne nøgler styrer du under Konto" : u.role === "admin" && !me?.super_admin ? "Kun superadministratoren kan nulstille en admins MFA" : undefined}
                  onClick={() => { if (confirm(`Nulstil MFA for ${v.name}? Passkeys, nøgler og apps slettes, og brugeren logges ud alle steder.`)) void act(() => api.post(`/api/admin/users/${u.id}/reset-mfa`), "MFA er nulstillet")(); }}>
                  Nulstil MFA
                </Btn>
                <Btn icon={KeyRound} height={40} deeplink="user-passkeys" disabled={!canResetKeys || !(sec.factors.passkeys + sec.factors.security_keys)}
                  onClick={act(() => api.post(`/api/admin/users/${u.id}/reset-passkeys`), "Passkeys er nulstillet")}>
                  Nulstil passkeys
                </Btn>
              </div>
            </Section>
          )}

          {!test && (
            <Section id="sessioner" title="Sessioner" deeplink="user-sessions">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
                <span style={{ flex: "1 1 280px", color: "#475569", fontSize: 14 }}>
                  {detail.sessions.length} {detail.sessions.length === 1 ? "aktiv session" : "aktive sessioner"}
                  {detail.sessions[0] ? ` · sidst set ${lastLabel(detail.sessions[0].last_seen_at)}` : ""}
                </span>
                <Btn icon={LogOut} height={40} disabled={!detail.sessions.length}
                  onClick={act(() => api.post(`/api/admin/users/${u.id}/revoke-sessions`), "Brugeren er logget ud alle steder")}>Log ud alle steder</Btn>
              </div>
            </Section>
          )}

          {!test && (
            <Section id="spaer" title="Spær" deeplink="user-block" danger>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <span style={{ flex: "1 1 280px", color: "#334155", fontSize: 14 }}>
                  {u.blocked_at ? `Spærret ${dateLabel(u.blocked_at)}. Brugeren kan ikke logge ind.` : "Spær kontoen. Brugeren logges ud alle steder og kan ikke logge ind."}
                </span>
                {u.blocked_at
                  ? <Btn icon={LockOpen} height={40} onClick={act(() => api.post(`/api/admin/users/${u.id}/unblock`), "Spærringen er ophævet")}>Ophæv spærring</Btn>
                  : <Btn kind="danger" icon={Ban} height={40} disabled={isMe || sup || lastAdmin}
                      title={isMe ? "Du kan ikke spærre dig selv" : sup ? "Superadministratoren kan ikke spærres" : undefined}
                      onClick={() => { if (confirm(`Spær ${v.name}?`)) void act(() => api.post(`/api/admin/users/${u.id}/block`), "Brugeren er spærret og logget ud")(); }}>Spær</Btn>}
              </div>
              <span style={hint}>Sletning af en bruger sker under GDPR-forespørgsler. Spær, log ud, nulstil og tilknyt virker med det samme og indgår ikke i Gem.</span>
            </Section>
          )}
        </main>
      </div>
      {dialog === "yubikey" && <YubiKeyDialog user={u} canInPerson={!isMe && (u.role !== "admin" || !!me?.super_admin)}
        onClose={() => setDialog(null)} onDone={async (text) => { setDialog(null); say(text); await load(true); onChanged(); }} />}
      {dialog === "recover" && <RecoverDialog user={u} canReset={canResetKeys && !!(sec.factors.total || u.mfa_required)}
        onClose={() => setDialog(null)} onDone={async (text) => { setDialog(null); say(text); await load(true); onChanged(); }} />}
    </Shell>
  );
}

function Shell({ children, deeplink, label = "Bruger" }: { children: ReactNode; deeplink?: string; label?: string }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={label} data-deeplink={deeplink}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "#f8fafc", overflowY: "auto", fontFamily: SANS, color: "#020817" }}>
      {children}
    </div>
  );
}

/** Tilknyt YubiKey: here (the user is present; the key becomes a second factor only) or a link mailed to the user. */
function YubiKeyDialog({ user: u, canInPerson, onClose, onDone }: {
  user: Detail["user"]; canInPerson: boolean; onClose: () => void; onDone: (text: string) => Promise<void>;
}) {
  const [how, setHow] = useState<"here" | "link">(canInPerson ? "here" : "link");
  const [name, setName] = useState("YubiKey");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (how === "here") {
        const { challenge_id, options } = await api.post<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
          `/api/admin/users/${u.id}/yubikey/options`);
        const credential = await startRegistration({ optionsJSON: options });
        await api.post(`/api/admin/users/${u.id}/yubikey/verify`, { challenge_id, credential, name });
        await onDone("YubiKeyen er tilknyttet");
      } else {
        await api.post(`/api/admin/users/${u.id}/yubikey/link`);
        await onDone(`Linket er sendt til ${u.email}`);
      }
    } catch (e) {
      setError(how === "here" ? passkeyErrorText(e) : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal width={560} z={70} onClose={onClose}>
      <strong style={{ fontSize: 19 }}>Tilknyt YubiKey til {u.display_name || u.email}</strong>
      <span style={{ color: "#475569", fontSize: 14 }}>Nøglen bliver brugerens andet trin til /admin og andre beskyttede områder.</span>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <legend style={{ fontWeight: 600, fontSize: 14, padding: "0 0 6px" }}>Hvordan tilknyttes nøglen?</legend>
        <label style={choice(how === "here", !canInPerson)}>
          <input type="radio" name="how" checked={how === "here"} disabled={!canInPerson} onChange={() => setHow("here")} style={{ marginTop: 3 }} />
          <span><strong>Her på denne computer</strong><br /><span style={hint}>
            {canInPerson ? "Brugeren er hos dig med nøglen og vælger selv nøglens PIN. Nøglen kan kun bruges efter brugerens egen engangskode."
              : "Kun superadministratoren kan tilknytte en nøgle til en anden admin på denne måde."}</span></span>
        </label>
        <label style={choice(how === "link", !u.email)}>
          <input type="radio" name="how" checked={how === "link"} disabled={!u.email} onChange={() => setHow("link")} style={{ marginTop: 3 }} />
          <span><strong>Send et link til brugeren</strong><br /><span style={hint}>
            {u.email ? `Engangslink til ${u.email}. Brugeren logger ind og sætter selv nøglen i.` : "Brugeren har ingen e-mailadresse."}</span></span>
        </label>
      </fieldset>
      {how === "here" && (
        <>
          <label style={field}>Navn på nøglen
            <input style={inputStyle} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 14, alignItems: "center", padding: 16, borderRadius: 12, background: "#f1f5f9" }}>
            <Usb size={28} color="#1d4ed8" />
            <span style={{ fontSize: 14, color: "#334155" }}>Tryk Start, sæt YubiKey&apos;en i og rør ved den. Tillad browseren at se nøglens model, når den spørger.</span>
          </div>
        </>
      )}
      <span style={{ ...hint, display: "flex", gap: 8 }}>Kun ægte YubiKeys godtages: nøglens attestering tjekkes, før den gemmes.</span>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn height={40} onClick={onClose}>Annullér</Btn>
        <Btn kind="primary" height={40} disabled={busy || (how === "link" && !u.email)} onClick={start}>
          {busy ? (how === "here" ? "Venter på nøglen …" : "Sender …") : how === "here" ? "Start" : "Send link"}
        </Btn>
      </div>
    </Modal>
  );
}

/** Gendan adgang: a login mail with a code and a link, optionally after resetting the user's second factors. */
function RecoverDialog({ user: u, canReset, onClose, onDone }: {
  user: Detail["user"]; canReset: boolean; onClose: () => void; onDone: (text: string) => Promise<void>;
}) {
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ expires_in: number }>(`/api/admin/users/${u.id}/login-link`, { reset_mfa: reset });
      await onDone(`Login-mail sendt til ${u.email}. Koden og linket virker i ${Math.round(r.expires_in / 60)} minutter.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal width={520} z={70} onClose={onClose}>
      <strong style={{ fontSize: 19 }}>Gendan adgang</strong>
      <span style={{ color: "#475569", fontSize: 14 }}>
        Der er ingen adgangskode at nulstille. Brugeren får en mail med en engangskode og et login-link. Har brugeren
        &quot;Kræv passkey&quot; eller YubiKey-kravet, skal andet trin stadig bruges efter linket.
      </span>
      {!u.email && <ErrorBox>Brugeren har ingen e-mailadresse og kan logge ind med en kode på SMS.</ErrorBox>}
      <label style={choice(reset, !canReset)}>
        <input type="checkbox" checked={reset} disabled={!canReset} onChange={(e) => setReset(e.target.checked)} style={{ marginTop: 3 }} />
        <span><strong>Nulstil også MFA</strong><br /><span style={hint}>
          {canReset ? "Til en bruger, der har mistet sin passkey, nøgle eller telefon: alle nøgler og apps slettes, og brugeren logges ud alle steder."
            : "Ingen nøgler at nulstille, eller kun superadministratoren må nulstille en admins MFA."}</span></span>
      </label>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn height={40} onClick={onClose}>Annullér</Btn>
        <Btn kind={reset ? "danger" : "primary"} icon={Mail} height={40} disabled={busy || !u.email} onClick={send}>
          {busy ? "Sender …" : reset ? "Nulstil og send login-mail" : "Send login-mail"}
        </Btn>
      </div>
    </Modal>
  );
}
