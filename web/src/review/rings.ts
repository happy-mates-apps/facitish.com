// The four rings as /admin/features names them (admin-app/theme.ts), with colours for markers and chips.
// A feature is shown when its ring is at least the level you view as: ring 1 sees everything, ring 4 only the stable.

export type RingInfo = { name: string; text: string; color: string; bg: string; ink: string };

export const RINGS: Record<number, RingInfo> = {
  1: { name: "Internt", text: "Kun internt. Kan ændre sig eller forsvinde uden varsel.", color: "#dc2626", bg: "#fee2e2", ink: "#991b1b" },
  2: { name: "Beta", text: "Til test med udvalgte. Virker, men er ikke færdigt.", color: "#d97706", bg: "#fef3c7", ink: "#92400e" },
  3: { name: "Preview", text: "Næsten klar. Alle ser det, med en besked.", color: "#2563eb", bg: "#dbeafe", ink: "#1e40af" },
  4: { name: "Stabilt", text: "Færdigt og for alle.", color: "#059669", bg: "#d1fae5", ink: "#065f46" },
};
