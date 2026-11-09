// Users as /api/admin/users returns them, and how /admin shows them (pills, avatar, labels).
import { AVATAR, initials, lastLabel, phoneLabel, type Tone } from "./theme";

export type AdminUser = {
  id: number;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  role: "user" | "admin";
  super_admin?: boolean;
  admin_roles?: string[];
  grace_logins_used: number;
  blocked_at: string | null;
  created_at: string;
  last_login_at: string | null;
  /** Passkeys and security keys. */
  passkeys: number;
  /** Confirmed authenticator apps. */
  totp: number;
  /** "Kræv passkey": the user's own MFA opt-in. */
  mfa_required: boolean;
  active_sessions: number;
  impersonation_only?: boolean;
  feature_ring?: number | null;
};

/** An administrative role as the server describes it (server/app/admin_roles.py). */
export type AdminRole = { key: string; label: string; description: string; sections: string[] };
export type UsersResponse = { items: AdminUser[]; total: number; grace_logins: number; admin_roles: AdminRole[] };

export const isTest = (u: AdminUser) => !!u.impersonation_only;
export const contactLabel = (u: Pick<AdminUser, "email" | "phone">) => u.email || phoneLabel(u.phone);
export const userName = (u: AdminUser) => u.display_name || contactLabel(u);

export const factorCount = (u: AdminUser) => u.passkeys + u.totp;

export function userView(u: AdminUser, grace: number) {
  const test = isTest(u);
  const factors = factorCount(u);
  // Admins need a second factor after the grace logins; other users are only nudged.
  const login: [string, Tone] = test ? ["Kun efterligning", "orange"]
    : u.mfa_required ? ["Kræver MFA", "green"]
    : factors > 0 ? [`${factors} ${factors > 1 ? "nøgler" : "nøgle"}`, "green"]
    : u.role !== "admin" ? ["Kun engangskode", "gray"]
    : u.grace_logins_used >= grace ? ["Mangler MFA til /admin", "orange"]
    : [`${u.grace_logins_used}/${grace} engangskoder`, "blue"];
  return {
    name: userName(u),
    initials: initials(u.display_name),
    avatar: test ? "#f59e0b" : AVATAR[u.id % AVATAR.length],
    sub: test ? `testkonto · #${u.id}` : `${u.display_name ? contactLabel(u) + " · " : ""}#${u.id}`,
    role: (u.super_admin ? ["Superadmin", "dark"] : u.role === "admin" ? ["Admin", "dark"] : ["Bruger", "gray"]) as [string, Tone],
    login,
    status: (u.blocked_at ? ["Spærret", "red"] : ["Aktiv", "green"]) as [string, Tone],
    sessions: `${u.active_sessions} ${u.active_sessions === 1 ? "aktiv session" : "aktive sessioner"}`,
    last: lastLabel(u.last_login_at),
  };
}
