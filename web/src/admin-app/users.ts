// Users as /api/admin/users returns them, and how /admin shows them (pills, avatar, labels).
import { AVATAR, initials, lastLabel, phoneLabel, type Tone } from "./theme";

export type AdminUser = {
  id: number;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  role: "user" | "admin";
  super_admin?: boolean;
  grace_logins_used: number;
  blocked_at: string | null;
  created_at: string;
  last_login_at: string | null;
  passkeys: number;
  active_sessions: number;
  impersonation_only?: boolean;
  feature_ring?: number | null;
};

export type UsersResponse = { items: AdminUser[]; total: number; grace_logins: number };

export const isTest = (u: AdminUser) => !!u.impersonation_only;
export const contactLabel = (u: Pick<AdminUser, "email" | "phone">) => u.email || phoneLabel(u.phone);
export const userName = (u: AdminUser) => u.display_name || contactLabel(u);

export function userView(u: AdminUser, grace: number) {
  const test = isTest(u);
  const login: [string, Tone] = u.passkeys > 0
    ? [`${u.passkeys} ${u.passkeys > 1 ? "passkeys" : "passkey"}`, "green"]
    : test ? ["Kun efterligning", "orange"]
    : u.grace_logins_used >= grace ? ["Skal oprette passkey", "orange"]
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
