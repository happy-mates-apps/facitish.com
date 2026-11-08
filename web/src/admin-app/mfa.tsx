// MFA in the admin app: the gate in front of /admin, the grace-login banner and the step-up dialog for security
// actions. Same server rules as the app on / (gaer-auth skill), but its own UI (the admin app may not import the app).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Fingerprint, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { errorText, setStepUpHandler } from "../api";
import { passkeyErrorText, registerPasskey, stepUpWithPasskey, stepUpWithTotp, useAuth, type MfaMethod } from "../auth";
import { SANS } from "./theme";
import { Btn, ErrorBox, Modal } from "./ui";

function SecondFactorForm({ methods, onDone }: { methods: MfaMethod[]; onDone: () => Promise<void> }) {
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => stepUpWithTotp(code), false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {methods.includes("passkey") && (
        <Btn kind="primary" icon={Fingerprint} height={40} disabled={busy || !browserSupportsWebAuthn()}
             onClick={() => run(stepUpWithPasskey, true)} style={{ justifyContent: "center" }}>
          Brug passkey eller sikkerhedsnøgle
        </Btn>
      )}
      {methods.includes("totp") && (
        <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-label="Kode fra godkendelsesapp"
                 placeholder="Kode fra app" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                 style={{ flex: 1, height: 40, padding: "0 12px", borderRadius: 8, border: "1px solid #e2e8f0", font: `600 16px ${SANS}`, letterSpacing: 4 }} />
          <Btn type="submit" height={40} disabled={busy || code.length !== 6}>Bekræft</Btn>
        </form>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ maxWidth: 460, margin: "12vh auto", padding: 28, background: "#ffffff", borderRadius: 16, boxShadow: "var(--hm-shadow-lg)",
      display: "flex", flexDirection: "column", gap: 16, fontFamily: SANS }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={22} color="#2563eb" />
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
      </div>
      {children}
    </div>
  );
}

/** Shown instead of /admin when the session has no second factor (and no grace login left). */
export function AdminMfaGate() {
  const { user, refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;
  const { methods } = user.mfa;
  if (methods.length) {
    return (
      <Card title="Bekræft at det er dig">
        <p style={{ margin: 0, color: "#64748b" }}>Administrationen kræver din passkey, sikkerhedsnøgle eller en kode fra din godkendelsesapp.</p>
        <SecondFactorForm methods={methods} onDone={refresh} />
        <a href="/" style={{ fontSize: 13 }}>← Til appen på /</a>
      </Card>
    );
  }
  const add = (kind: "passkey" | "security_key") => async () => {
    setError(null);
    try {
      await registerPasskey(undefined, kind);
      await refresh();
    } catch (e) {
      setError(passkeyErrorText(e));
    }
  };
  return (
    <Card title="Opret en anden faktor">
      <p style={{ margin: 0, color: "#64748b" }}>
        Du har brugt dine logins med engangskode. Administrationen kræver nu en passkey, en sikkerhedsnøgle (fx YubiKey)
        eller en godkendelsesapp.
      </p>
      <Btn kind="primary" icon={Fingerprint} height={40} onClick={add("passkey")} disabled={!browserSupportsWebAuthn()} style={{ justifyContent: "center" }}>
        Opret passkey på denne enhed
      </Btn>
      <Btn icon={KeyRound} height={40} onClick={add("security_key")} disabled={!browserSupportsWebAuthn()} style={{ justifyContent: "center" }}>
        Tilføj sikkerhedsnøgle
      </Btn>
      <a href="/konto#sikkerhed" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
        <Smartphone size={14} /> Brug en godkendelsesapp (opsættes under Konto)
      </a>
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

/** While an admin still logs in with grace logins: how many are left. */
export function GraceBanner() {
  const { user } = useAuth();
  const left = user?.mfa.admin_grace_left;
  if (left === null || left === undefined) return null;
  return (
    <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fffbeb", border: "1px solid rgba(245,158,11,0.35)", color: "#78350f", fontSize: 13 }}>
      {left > 0 ? `${left} ${left === 1 ? "login" : "logins"} med engangskode tilbage. ` : "Sidste login med engangskode. "}
      Derefter kræver /admin en passkey, sikkerhedsnøgle eller godkendelsesapp. <a href="/konto#sikkerhed">Opret nu</a>
    </div>
  );
}

/** Security actions (roles, contact details, blocking, MFA reset, erasure …) need a recent second factor. This dialog
 * is opened by api.ts when the server asks for it, and the action is repeated afterwards. */
export function AdminStepUp() {
  const { user, refresh } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const methods = useRef<MfaMethod[]>([]);
  methods.current = user?.mfa.methods ?? [];

  useEffect(() => {
    // Calls that fail at the same time (e.g. a page loading several lists) share one dialog.
    setStepUpHandler((_code, text) => {
      if (methods.current.length === 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waiting.current.push(resolve);
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
    <Modal width={420} z={80} onClose={() => close(false)}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={20} color="#2563eb" />
        <strong style={{ fontSize: 17 }}>Bekræft at det er dig</strong>
      </div>
      <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>{message}. Det gælder handlinger, der ændrer adgang og sikkerhed.</p>
      <SecondFactorForm methods={methods.current} onDone={async () => { await refresh(); close(true); }} />
      <Btn kind="ghost" onClick={() => close(false)}>Annullér</Btn>
    </Modal>
  );
}
