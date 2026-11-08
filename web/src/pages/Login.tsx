import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { api, errorText } from "../api";
import { loginWithPasskey, passkeyErrorText, registerPasskey, useAuth, type LoginResult, type MfaMethod } from "../auth";
import { SecondFactor } from "../security";
import { Alert } from "../ui";
import { solveCaptcha } from "../captcha";

// After the code: users with "Kræv passkey" prove their second factor (step "mfa"); everybody else is logged in
// and offered a passkey (step "offer"). Admins also see how many grace logins /admin has left.
type Step =
  | { kind: "phone" }
  | { kind: "code"; devCode?: string }
  | { kind: "offer"; adminGraceLeft: number | null; becameAdmin: boolean }
  | { kind: "mfa"; methods: MfaMethod[] };

const GRACE_LOGINS = 3;

function GracePills({ left }: { left: number }) {
  const used = GRACE_LOGINS - left;
  return (
    <div className="grace-row" aria-label={`${used} af ${GRACE_LOGINS} logins til administrationen med engangskode brugt`}>
      {Array.from({ length: GRACE_LOGINS }, (_, i) => (
        <span key={i} className={`pill ${i < used ? "blue" : ""}`}>
          {i + 1} · engangskode
        </span>
      ))}
      <span className="pill dark">Derefter nøgle til /admin</span>
    </div>
  );
}

export default function Login({ home = "/", embedded = false }: { home?: string; embedded?: boolean }) {
  const { user, scope, refresh, config } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Where to go after login: state from RequireUser, or ?next= (same-site paths only) from /admin and MCP.
  const next = new URLSearchParams(location.search).get("next");
  const from = (location.state as { from?: string } | null)?.from
    ?? (next && next.startsWith("/") && !next.startsWith("//") ? next : home);
  // /admin is a separate app, so it needs a full page load.
  const goFrom = () => (from === "/admin" || from.startsWith("/admin/") ? window.location.assign(from) : navigate(from, { replace: true }));
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [channel, setChannel] = useState<"email" | "phone">("email");
  const [phone, setPhone] = useState("");
  const contact = channel === "email" ? { email: phone.trim() } : { phone };
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supportsPasskey = browserSupportsWebAuthn();

  // Arriving with a pending login (e.g. after a reload) goes straight to the second factor.
  useEffect(() => {
    if (user && scope === "mfa" && step.kind === "phone") setStep({ kind: "mfa", methods: user.mfa.methods });
    if (user && scope === "full" && step.kind === "phone") goFrom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, scope, step.kind, from]);

  const after = async (res: LoginResult) => {
    await refresh();
    if (res.status === "mfa_required") setStep({ kind: "mfa", methods: res.methods });
    else if ((res.offer_passkey && supportsPasskey) || res.became_admin || (res.admin_grace_left ?? null) !== null)
      setStep({ kind: "offer", adminGraceLeft: res.admin_grace_left ?? null, becameAdmin: !!res.became_admin });
    else goFrom();
  };

  const run = async (fn: () => Promise<void>, passkey = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(passkey ? passkeyErrorText(e) : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // The robot check is solved in the background while the person types, so sending the code is not slower.
  const captcha = useRef<Promise<string | null> | null>(null);
  const nextCaptcha = () => {
    captcha.current = solveCaptcha();
    captcha.current.catch(() => {}); // the error is shown when the code is sent
  };
  useEffect(() => {
    if (config?.captcha && step.kind === "phone" && !captcha.current) nextCaptcha();
  }, [config?.captcha, step.kind]);

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    run(async () => {
      let solution: string | null = null;
      if (config?.captcha) {
        if (!captcha.current) nextCaptcha();
        try {
          solution = await captcha.current;
        } finally {
          captcha.current = null; // a solution works once
        }
      }
      const res = await api.post<{ dev_code?: string }>("/api/auth/otp/start", { ...contact, captcha: solution });
      setCode("");
      setStep({ kind: "code", devCode: res.dev_code });
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await after(await api.post<LoginResult>("/api/auth/otp/verify", { ...contact, code }));
    });
  };

  const createPasskey = () =>
    run(async () => {
      await registerPasskey();
      await refresh();
      goFrom();
    }, true);

  const passkeyLogin = () => run(async () => after(await loginWithPasskey()), true);

  return (
    <div className={`auth-shell${embedded ? " embedded" : ""}`}>
      <div className="auth-card glow">
        <div className="card">
          {step.kind === "phone" && (
            <form className="stack" style={{ "--gap": "16px" } as React.CSSProperties} onSubmit={sendCode}>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <div className="eyebrow">Log ind</div>
                <h2>{channel === "email" ? "Din e-mailadresse" : "Dit telefonnummer"}</h2>
                <p className="muted small">{channel === "email" ? "Vi sender en engangskode på mail." : "Vi sender en engangskode på SMS."}</p>
              </div>
              {config?.first_user && (
                <Alert kind="warn">
                  Instansen er ny og har ingen brugere. Du bliver den første bruger og dermed <strong>superadministrator</strong>.
                </Alert>
              )}
              {config?.demo_mode && (
                <Alert kind="info">Demo: koden bliver ikke sendt, men skrevet i serverens log.</Alert>
              )}
              {channel === "email" ? (
                <label className="field">
                  E-mail
                  <input type="email" autoComplete="email" placeholder="navn@firma.dk" value={phone}
                         onChange={(e) => setPhone(e.target.value)} required autoFocus />
                </label>
              ) : (
                <label className="field">
                  Telefonnummer
                  <input type="tel" autoComplete="tel" inputMode="tel" placeholder="12 34 56 78" value={phone}
                         onChange={(e) => setPhone(e.target.value)} required autoFocus />
                </label>
              )}
              <Alert>{error}</Alert>
              <button className="btn btn-primary btn-block" disabled={busy || phone.trim().length < 6}>
                {busy && config?.captcha ? "Tjekker og sender …" : "Send kode"}
              </button>
              {config?.captcha && (
                <p className="muted tiny" style={{ textAlign: "center" }}>
                  Et lille robottjek kører i din browser. Ingen cookies, intet sendes til andre.
                </p>
              )}
              {config?.sms_login && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setChannel(channel === "email" ? "phone" : "email"); setPhone(""); setError(null); }}>
                  {channel === "email" ? "Brug telefonnummer i stedet" : "Brug e-mail i stedet"}
                </button>
              )}
              {supportsPasskey && (
                <>
                  <div className="row muted tiny" style={{ justifyContent: "center" }}>eller</div>
                  <button type="button" className="btn btn-dark btn-block" onClick={passkeyLogin} disabled={busy}>
                    Log ind med passkey
                  </button>
                </>
              )}
            </form>
          )}

          {step.kind === "code" && (
            <form className="stack" style={{ "--gap": "16px" } as React.CSSProperties} onSubmit={verify}>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <div className="eyebrow">Engangskode</div>
                <h2>Skriv koden</h2>
                <p className="muted small">Vi har sendt en kode til {phone}. Den kan kun bruges én gang og udløber om få minutter.</p>
              </div>
              {step.devCode && <Alert kind="info">Udvikling: koden er <strong className="mono">{step.devCode}</strong></Alert>}
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                     onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Engangskode" autoFocus />
              <Alert>{error}</Alert>
              <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>Log ind</button>
              <div className="spread">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep({ kind: "phone" })}>{channel === "email" ? "Skift e-mail" : "Skift nummer"}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => sendCode()} disabled={busy}>Send ny kode</button>
              </div>
            </form>
          )}

          {step.kind === "offer" && (
            <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <div className="eyebrow">Du er logget ind</div>
                <h2>Opret en passkey</h2>
                <p className="muted small">
                  Næste gang logger du ind med fingeraftryk, ansigt eller enhedens kode, uden at vente på en mail.
                  {step.adminGraceLeft !== null && " Administrationen kræver en passkey, sikkerhedsnøgle eller godkendelsesapp efter "
                    + `${GRACE_LOGINS} logins med engangskode.`}
                </p>
              </div>
              {step.becameAdmin && <Alert kind="success">Du er den første bruger og er nu {user?.super_admin ? "superadministrator" : "administrator"}. Du finder administrationen under /admin.</Alert>}
              {step.adminGraceLeft !== null && <GracePills left={step.adminGraceLeft} />}
              {!supportsPasskey && <Alert kind="info">Din browser understøtter ikke passkeys. Du kan bruge en godkendelsesapp under Konto.</Alert>}
              <Alert>{error}</Alert>
              {supportsPasskey && <button className="btn btn-primary btn-block" onClick={createPasskey} disabled={busy}>Opret passkey nu</button>}
              <button className="btn btn-ghost btn-block" onClick={() => goFrom()}>
                {step.adminGraceLeft !== null && step.adminGraceLeft > 0
                  ? `Ikke nu (${step.adminGraceLeft} ${step.adminGraceLeft === 1 ? "login" : "logins"} til /admin tilbage)` : "Ikke nu"}
              </button>
            </div>
          )}

          {step.kind === "mfa" && (
            <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
              <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                <div className="eyebrow">Totrinsbekræftelse</div>
                <h2>Bekræft at det er dig</h2>
                <p className="muted small">Din konto kræver en passkey, sikkerhedsnøgle eller kode fra din godkendelsesapp.</p>
              </div>
              <SecondFactor methods={step.methods} onDone={async () => { await refresh(); goFrom(); }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
