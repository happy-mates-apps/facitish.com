// Beskeder in /admin (specs/beskeder): types and small parts shared by Overblik, Send besked, Svar, Levering and
// Kanaler og regler. The API is /api/admin/messages/…; each sub-path is its own section, so admin roles split the work.
import type { CSSProperties, ReactNode } from "react";
import { card, sectionLabel, type Tone } from "../../theme";
import { Pill } from "../../ui";

export type Audience =
  | { kind: "all" } | { kind: "admins" } | { kind: "ring"; ring: number } | { kind: "inactive"; days: number }
  | { kind: "users"; user_ids: number[] };
export type Channel = "sms" | "mail";

export type Estimate = {
  total: number; push: number; sms: number; mail: number; app_only: number; segments: number; encoding: string;
  price_minor: number; currency: string; label: string; sms_enabled: boolean; mail_enabled: boolean;
};

export type Broadcast = {
  id: number; title: string; body: string; audience_label: string; channels: Channel[]; urgent: boolean;
  allow_replies: boolean; status: "scheduled" | "sending" | "sent"; total: number; sms: number; mail: number;
  app_only: number; price_minor: number; segments: number; actor_name: string | null; replies: number;
  unread_in_app: number; send_at: string | null; sent_at: string | null; created_at: string;
};

export type MessageSettings = {
  sms_enabled: boolean; mail_enabled: boolean; sms_price_minor: number; quiet_start: string; quiet_end: string;
  time_zone: string; sms_max_per_hour: number; duplicate_seconds: number; inactive_days: number; sms_provider: string;
  sms_sender?: string;
};

export const muted: CSSProperties = { fontSize: 13, color: "#64748b" };
export const box: CSSProperties = { ...card, padding: 20, display: "flex", flexDirection: "column", gap: 12 };

export function kr(minor: number): string {
  return (minor / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `I dag ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `I går ${time}`;
  return `${d.toLocaleDateString("da-DK", { day: "numeric", month: "short" })} ${time}`;
}

export function people(n: number): string {
  return n === 1 ? "1 modtager" : `${n.toLocaleString("da-DK")} modtagere`;
}

export function split(b: { sms: number; mail: number; app_only: number }): string {
  return `${b.sms} SMS · ${b.mail} e-mail · ${b.app_only} kun i appen`;
}

const STATUS: Record<string, [string, Tone]> = {
  queued: ["I kø", "blue"], held: ["Holdt", "gray"], sent: ["Sendt", "blue"], delivered: ["Leveret", "green"],
  read: ["Læst", "green"], failed: ["Fejlet", "red"], skipped: ["Sprunget over", "gray"], duplicate: ["Dublet", "gray"],
  throttled: ["Droslet", "orange"],
};
export function StatusPill({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "gray"];
  return <Pill tone={tone}>{label}</Pill>;
}

export const CHANNEL: Record<string, string> = { app: "I appen", push: "Push", sms: "SMS", mail: "E-mail" };

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={box}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ ...sectionLabel, margin: 0 }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "#b91c1c" : tone === "warn" ? "#92400e" : "#020817";
  return (
    <div style={{ ...card, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0,
      borderColor: tone === "warn" ? "#fde68a" : "#e2e8f0" }}>
      <span style={{ ...sectionLabel, color: tone === "warn" ? "#92400e" : "#64748b" }}>{label}</span>
      <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums", color }}>{value}</span>
      {note && <span style={{ ...muted, fontSize: 12 }}>{note}</span>}
    </div>
  );
}

export const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 };
