import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

export type User = {
  id: number;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  role: "user" | "admin";
  super_admin: boolean;
  /** Admins: roles (server/app/admin_roles.py) and the /admin sections they open, e.g. ["/", "/users"]. */
  admin_roles: string[];
  admin_sections: string[];
  locale: "da" | "en" | null;
  avatar_url: string | null;
  /** Passkeys and security keys. */
  passkeys: number;
  mfa: MfaStatus;
};

/** Second factors: passkeys, security keys (YubiKey) and authenticator apps. See the gaer-auth skill. */
export type MfaMethod = "passkey" | "totp";
export type MfaStatus = {
  /** "Kræv passkey": the user's own choice; a code alone is not enough to log in. */
  required: boolean;
  factors: number;
  methods: MfaMethod[];
  /** This session may use /admin (second factor or a grace login within the last hours). */
  admin_ok: boolean;
  /** Admins without a second factor: logins with a code left before /admin requires one. */
  admin_grace_left: number | null;
};

export type Scope = "full" | "mfa";

export type PublicConfig = {
  app_name: string;
  logo_url: string | null;
  consent_version: number;
  consent_title: string;
  consent_text: string;
  consent_accept: string;
  consent_decline: string;
  first_user: boolean;
  sms_login: boolean;
  demo_mode: boolean;
  /** POST /api/auth/otp/start needs a solved robot check (src/captcha.ts). */
  captcha: boolean;
};

type AuthState = {
  user: User | null;
  /** Set when an admin is viewing the app as a test account (/admin → Efterligning). */
  impersonator: { id: number; display_name: string | null } | null;
  /** "mfa" = logged in with a code, the second factor is still missing (only /api/auth/mfa/* works). */
  scope: Scope | null;
  loading: boolean;
  config: PublicConfig | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [impersonator, setImpersonator] = useState<AuthState["impersonator"]>(null);
  const [scope, setScope] = useState<AuthState["scope"]>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<PublicConfig | null>(null);

  const refresh = useCallback(async () => {
    const [me, cfg] = await Promise.all([
      api.get<{ user: User | null; scope?: Scope; impersonator?: AuthState["impersonator"] }>("/api/auth/me"),
      api.get<PublicConfig>("/api/public/config"),
    ]);
    setUser(me.user);
    setImpersonator(me.impersonator ?? null);
    setScope(me.scope ?? null);
    setConfig(cfg);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (config) document.title = config.app_name;
  }, [config]);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout");
    setUser(null);
    setScope(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, impersonator, scope, loading, config, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

// Passkeys (WebAuthn) — the server creates the options and verifies the result.

type Options<T> = { challenge_id: string; options: T };

/** kind "security_key" asks the browser for a separate key (YubiKey …) instead of the device itself. */
export async function registerPasskey(name?: string, kind: "passkey" | "security_key" = "passkey"): Promise<void> {
  const { challenge_id, options } = await api.post<Options<Parameters<typeof startRegistration>[0]["optionsJSON"]>>(
    "/api/auth/passkey/register/options", { kind },
  );
  const credential = await startRegistration({ optionsJSON: options });
  await api.post("/api/auth/passkey/register/verify", { challenge_id, credential, name });
}

/** Second factor with a passkey or security key: completes a pending login or steps up the session. */
export async function stepUpWithPasskey(): Promise<void> {
  const { challenge_id, options } = await api.post<
    Options<Parameters<typeof startAuthentication>[0]["optionsJSON"]>
  >("/api/auth/mfa/passkey/options");
  const credential = await startAuthentication({ optionsJSON: options });
  await api.post("/api/auth/mfa/passkey/verify", { challenge_id, credential });
}

/** Second factor with a 6-digit code from an authenticator app. */
export async function stepUpWithTotp(code: string): Promise<void> {
  await api.post("/api/auth/mfa/totp/verify", { code });
}

export type TotpSetup = { id: number; secret: string; uri: string; qr_svg: string; digits: number; period: number };

/** Adding an authenticator app: start returns the secret and a QR code (shown once), confirm with a code. */
export const totpSetup = {
  start: (name?: string) => api.post<TotpSetup>("/api/me/totp", name ? { name } : {}),
  confirm: (id: number, code: string) => api.post(`/api/me/totp/${id}/confirm`, { code }),
};

export async function loginWithPasskey(): Promise<LoginResult> {
  const { challenge_id, options } = await api.post<
    Options<Parameters<typeof startAuthentication>[0]["optionsJSON"]>
  >("/api/auth/passkey/login/options");
  const credential = await startAuthentication({ optionsJSON: options });
  return api.post<LoginResult>("/api/auth/passkey/login/verify", { challenge_id, credential });
}

/** What /api/auth/otp/verify and /api/auth/passkey/login/verify answer. */
export type LoginResult =
  | { status: "logged_in"; offer_passkey?: boolean; admin?: boolean; admin_grace_left?: number | null; became_admin?: boolean }
  | { status: "mfa_required"; methods: MfaMethod[] };

export function passkeyErrorText(e: unknown): string {
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) {
    return "Handlingen blev afbrudt. Prøv igen.";
  }
  return e instanceof Error ? e.message : "Noget gik galt";
}
