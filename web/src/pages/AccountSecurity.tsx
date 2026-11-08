// /konto#sikkerhed: passkeys, security keys (YubiKey), authenticator apps and "Kræv passkey".
// Uses GET /api/me/security; changes that need a recent second factor open the step-up dialog by themselves.
import { useState, type FormEvent } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { api, errorText } from "../api";
import { passkeyErrorText, registerPasskey, totpSetup, useAuth, type TotpSetup } from "../auth";
import { Alert, fmtDate, Loading, useLoad } from "../ui";

type Key = { id: number; name: string; kind: "passkey" | "security_key"; created_at: string; last_used_at: string | null };
type App = { id: number; name: string; created_at: string; last_used_at: string | null };
type Advice = "add_passkey" | "admin_needs_mfa" | "add_backup_factor" | "enable_mfa";
export type Security = {
  mfa_required: boolean;
  factors: { passkeys: number; security_keys: number; totp: number; total: number };
  passkeys: Key[];
  security_keys: Key[];
  totp: App[];
  session: { mfa_at: string | null; stepup_ok: boolean; grace: boolean };
  admin: { ok: boolean; grace_logins: number; grace_left: number; mfa_hours: number } | null;
  active_sessions: number;
  advice: Advice[];
};

const ADVICE: Record<Advice, string> = {
  add_passkey: "Opret en passkey, så logger du ind med fingeraftryk, ansigt eller enhedens kode i stedet for en kode på mail.",
  admin_needs_mfa: "Som administrator skal du have en passkey, sikkerhedsnøgle eller godkendelsesapp for at bruge /admin.",
  add_backup_factor: "Tilføj en ekstra nøgle eller app som reserve, hvis du mister den første.",
  enable_mfa: "Slå “Kræv passkey” til, så en kode på mail ikke alene er nok til at logge ind.",
};

const row = { borderTop: "1px solid var(--hm-border)", paddingTop: 10 };
const stack2 = { "--gap": "2px" } as React.CSSProperties;

export default function AccountSecurity() {
  const { refresh } = useAuth();
  const sec = useLoad(() => api.get<Security>("/api/me/security"));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const webauthn = browserSupportsWebAuthn();

  const act = async (fn: () => Promise<unknown>, ok?: string, passkey = false) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      await Promise.all([sec.reload(), refresh()]);
      if (ok) setMessage(ok);
    } catch (e) {
      setError(passkey ? passkeyErrorText(e) : errorText(e));
    }
  };

  const confirmTotp = (e: FormEvent) => {
    e.preventDefault();
    if (setup) act(async () => {
      await totpSetup.confirm(setup.id, code);
      setSetup(null);
      setCode("");
    }, "Godkendelsesappen er tilføjet");
  };

  const keyRow = (k: Key) => (
    <div key={k.id} className="spread" style={row}>
      <div className="stack" style={stack2}>
        <strong>{k.name}</strong>
        <span className="muted tiny">Oprettet {fmtDate(k.created_at)} · Sidst brugt {fmtDate(k.last_used_at)}</span>
      </div>
      <div className="row" style={{ "--gap": "4px" } as React.CSSProperties}>
        <button className="btn btn-ghost btn-sm" onClick={() => {
          const n = prompt("Nyt navn", k.name);
          if (n) act(() => api.patch(`/api/me/passkeys/${k.id}`, { name: n }));
        }}>Omdøb</button>
        <button className="btn btn-danger btn-sm" onClick={() => {
          if (confirm(`Slet "${k.name}"? Du kan ikke længere logge ind med den.`)) act(() => api.del(`/api/me/passkeys/${k.id}`), "Slettet");
        }}>Slet</button>
      </div>
    </div>
  );

  const s = sec.data;
  return (
    <div className="card" id="sikkerhed" data-deeplink="account-security">
      <span className="eyebrow">Sikkerhed</span>
      <Alert kind="success">{message}</Alert>
      <Alert>{error}</Alert>
      {!s ? <Loading /> : (
        <>
          {s.advice.map((a) => <Alert key={a} kind={a === "admin_needs_mfa" ? "warn" : "info"}>{ADVICE[a]}</Alert>)}
          {s.admin && (
            <p className="small">
              <strong>Administration:</strong>{" "}
              {s.factors.total ? (s.admin.ok ? "klar." : `bekræft med din nøgle, når du åbner /admin (gælder ${s.admin.mfa_hours} timer).`)
                : `${s.admin.grace_left} af ${s.admin.grace_logins} logins med engangskode tilbage, før /admin kræver en nøgle.`}
            </p>
          )}

          <label className="row" style={{ "--gap": "10px", alignItems: "flex-start" } as React.CSSProperties}>
            <input type="checkbox" checked={s.mfa_required} disabled={!s.factors.total}
                   onChange={(e) => act(() => api.put("/api/me/mfa", { required: e.target.checked }),
                     e.target.checked ? "Kræv passkey er slået til" : "Kræv passkey er slået fra")} />
            <span className="stack" style={stack2}>
              <strong>Kræv passkey ved login</strong>
              <span className="muted small">
                En kode på mail er ikke længere nok: du skal også bruge din passkey, sikkerhedsnøgle eller godkendelsesapp.
                {!s.factors.total && " Tilføj en først."}
              </span>
            </span>
          </label>

          <div className="spread" style={row}>
            <strong>Passkeys</strong>
            <button className="btn btn-outline btn-sm" disabled={!webauthn}
                    onClick={() => act(() => registerPasskey(), "Passkey oprettet", true)}>Tilføj passkey</button>
          </div>
          {s.passkeys.length === 0 ? <p className="muted small">Ingen endnu. Passkeys bruger enhedens fingeraftryk, ansigt eller kode.</p> : s.passkeys.map(keyRow)}

          <div className="spread" style={row}>
            <strong>Sikkerhedsnøgler</strong>
            <button className="btn btn-outline btn-sm" disabled={!webauthn}
                    onClick={() => act(() => registerPasskey(undefined, "security_key"), "Sikkerhedsnøglen er tilføjet", true)}>
              Tilføj sikkerhedsnøgle
            </button>
          </div>
          {s.security_keys.length === 0 ? <p className="muted small">Fx en YubiKey. Nøglen skal have en PIN-kode.</p> : s.security_keys.map(keyRow)}

          <div className="spread" style={row}>
            <strong>Godkendelsesapps</strong>
            {!setup && <button className="btn btn-outline btn-sm" onClick={() => act(async () => setSetup(await totpSetup.start()))}>
              Tilføj godkendelsesapp
            </button>}
          </div>
          {setup && (
            <form className="stack" style={{ "--gap": "10px" } as React.CSSProperties} onSubmit={confirmTotp}>
              <p className="small">Scan koden med fx Microsoft Authenticator, Google Authenticator eller 1Password, og skriv den 6-cifrede kode.</p>
              <img className="qr" alt="QR-kode til godkendelsesappen" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} />
              <p className="muted tiny">Kan du ikke scanne? Skriv nøglen: <span className="mono">{setup.secret.match(/.{1,4}/g)?.join(" ")}</span> · <a href={setup.uri}>Åbn i app</a></p>
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                     onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Kode fra appen" />
              <div className="row">
                <button className="btn btn-primary btn-sm" disabled={code.length !== 6}>Bekræft</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSetup(null); setCode(""); }}>Annullér</button>
              </div>
            </form>
          )}
          {s.totp.length === 0 && !setup ? <p className="muted small">En app på telefonen, der viser en ny kode hvert 30. sekund.</p> : s.totp.map((t) => (
            <div key={t.id} className="spread" style={row}>
              <div className="stack" style={stack2}>
                <strong>{t.name}</strong>
                <span className="muted tiny">Oprettet {fmtDate(t.created_at)} · Sidst brugt {fmtDate(t.last_used_at)}</span>
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => {
                if (confirm(`Fjern "${t.name}"?`)) act(() => api.del(`/api/me/totp/${t.id}`), "Godkendelsesappen er fjernet");
              }}>Fjern</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
