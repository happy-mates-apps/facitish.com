// Second factor in the app on /: the step at login, the step-up dialog and the passkey nudge.
// The rules (who needs what) live on the server; see the gaer-auth and gaer-profile skills.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { errorText, setStepUpHandler } from "./api";
import { passkeyErrorText, stepUpWithPasskey, stepUpWithTotp, useAuth, type MfaMethod } from "./auth";
import { Alert } from "./ui";

/** Passkey/security key button and/or a field for a code from an authenticator app. yubikey: the server asked for a
 * YubiKey (users with the YubiKey requirement, on admin-level actions): only the user's YubiKeys are offered. */
export function SecondFactor({ methods, onDone, yubikey = false }: { methods: MfaMethod[]; onDone: () => void | Promise<void>; yubikey?: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>, passkey: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (e) {
      setError(passkey ? passkeyErrorText(e) : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    run(() => stepUpWithTotp(code), false);
  };

  if (yubikey) {
    return (
      <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
        <button className="btn btn-primary btn-block" disabled={busy || !browserSupportsWebAuthn()}
                onClick={() => run(() => stepUpWithPasskey({ yubikey: true }), true)}>
          {busy ? "Venter på nøglen …" : "Brug YubiKey"}
        </button>
        <p className="muted tiny" style={{ margin: 0 }}>Din konto kræver en YubiKey her. Sæt den i og rør ved den, når den blinker.</p>
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (methods.length === 0) {
    return (
      <Alert kind="warn">
        Din konto kræver en passkey, sikkerhedsnøgle eller godkendelsesapp, men der er ingen tilknyttet. Kontakt en
        administrator, så kan de nulstille det.
      </Alert>
    );
  }
  return (
    <div className="stack" style={{ "--gap": "12px" } as React.CSSProperties}>
      {methods.includes("passkey") && (
        <button className="btn btn-primary btn-block" disabled={busy || !browserSupportsWebAuthn()}
                onClick={() => run(() => stepUpWithPasskey(), true)}>
          Brug passkey eller sikkerhedsnøgle
        </button>
      )}
      {methods.includes("totp") && (
        <form className="stack" style={{ "--gap": "8px" } as React.CSSProperties} onSubmit={submitCode}>
          {methods.includes("passkey") && <div className="row muted tiny" style={{ justifyContent: "center" }}>eller</div>}
          <label className="field">
            Kode fra godkendelsesapp
            <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                   onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus={!methods.includes("passkey")} />
          </label>
          <button className="btn btn-outline btn-block" disabled={busy || code.length !== 6}>Bekræft kode</button>
        </form>
      )}
      <Alert>{error}</Alert>
    </div>
  );
}

/** Mounted once in App.tsx. When the server answers stepup_required/mfa_required, it asks for the second factor and
 * the API call is repeated (api.ts setStepUpHandler). Calls that fail at the same time share one dialog. */
export function StepUpDialog() {
  const { user, refresh } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [yubikey, setYubikey] = useState(false);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const methods = useRef<MfaMethod[]>([]);
  methods.current = user?.mfa.methods ?? [];

  useEffect(() => {
    setStepUpHandler((code, text) => {
      if (methods.current.length === 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waiting.current.push(resolve);
        setYubikey(code === "yubikey_stepup_required" || code === "yubikey_required");
        setMessage((m) => m ?? text);
      });
    });
    return () => setStepUpHandler(null);
  }, []);

  if (message === null) return null;
  const close = (ok: boolean) => {
    const all = waiting.current;
    waiting.current = [];
    setMessage(null);
    all.forEach((resolve) => resolve(ok));
  };
  return (
    <div className="dialog-backdrop" role="presentation" onClick={() => close(false)}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="stepup-title" onClick={(e) => e.stopPropagation()}>
        <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <div className="eyebrow">Sikkerhed</div>
          <h3 id="stepup-title">Bekræft at det er dig</h3>
          <p className="muted small">{message}</p>
        </div>
        <SecondFactor methods={methods.current} yubikey={yubikey} onDone={async () => { await refresh(); close(true); }} />
        <button className="btn btn-ghost btn-sm" onClick={() => close(false)}>Annullér</button>
      </div>
    </div>
  );
}

const NUDGE_KEY = "gaer.passkeyNudge";
const NUDGE_DAYS = 14;

/** A friendly reminder for users without a passkey. "Ikke nu" hides it for 14 days on this device. */
export function PasskeyNudge() {
  const { user } = useAuth();
  const [hidden, setHidden] = useState(() => Number(localStorage.getItem(NUDGE_KEY) ?? 0) > Date.now());
  if (!user || user.passkeys > 0 || !browserSupportsWebAuthn()) return null;
  const adminGrace = user.mfa.admin_grace_left;
  if (hidden && adminGrace === null) return null;
  return (
    <div className={`alert ${adminGrace !== null ? "warn" : "info"}`}>
      {adminGrace !== null ? (
        <>Administrationen kræver en passkey, sikkerhedsnøgle eller godkendelsesapp.{" "}
          {adminGrace > 0 ? `Du har ${adminGrace} ${adminGrace === 1 ? "login" : "logins"} med engangskode tilbage.` : "Opret en nu."}{" "}</>
      ) : (
        <>Log hurtigere og mere sikkert ind med fingeraftryk, ansigt eller enhedens kode.{" "}</>
      )}
      <Link to="/konto#sikkerhed">Opret passkey</Link>
      {adminGrace === null && (
        <>{" · "}<button className="btn btn-ghost btn-sm" onClick={() => {
          localStorage.setItem(NUDGE_KEY, String(Date.now() + NUDGE_DAYS * 86400000));
          setHidden(true);
        }}>Ikke nu</button></>
      )}
    </div>
  );
}
