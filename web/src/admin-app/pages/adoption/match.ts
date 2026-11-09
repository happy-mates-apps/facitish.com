// The matching rules of server/app/adoption_match.py, for the live preview in the setup form.
// Keep them in step with the server: the vectors in server/tests/test_adoption.py (MATCH_CASES) are, among others,
//   exact  /klip      → /klip ✓  /klip/42 ✗        glob  /klip/*   → /klip/:id ✓  /klip ✗  /klip/42/x ✗
//   prefix /extension → /extension/klip ✓          glob  /extension/** → /extension/tools/word ✓
//   regex  ^/(m|extension)/klip$ → /m/klip ✓  /klip ✗

export type MatchType = "exact" | "prefix" | "glob" | "regex";

export const MATCH_TYPES: { value: MatchType; label: string; hint: string; example: string }[] = [
  { value: "exact", label: "Præcis", hint: "Kun præcis denne side (en afsluttende / ignoreres).", example: "/klip" },
  { value: "prefix", label: "Starter med", hint: "Alle sider der starter sådan — undersider tæller med.", example: "/extension" },
  { value: "glob", label: "Mønster", hint: "* matcher ét led i stien, ** matcher resten af stien.", example: "/klip/*" },
  { value: "regex", label: "Regex", hint: "Et regulært udtryk mod stien.", example: "^/(m|extension)/klip$" },
];

export const MATCH_LABEL: Record<MatchType, string> = Object.fromEntries(MATCH_TYPES.map((m) => [m.value, m.label])) as Record<MatchType, string>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function toRegExp(type: MatchType, pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  try {
    if (type === "exact") return new RegExp(`^${escape(p.replace(/\/+$/, ""))}/?$`);
    if (type === "prefix") return new RegExp(`^${escape(p.replace(/\*+$/, ""))}`);
    if (type === "glob") return new RegExp(`^${p.split("**").map((part) => part.split("*").map(escape).join("[^/]+")).join(".*")}/?$`);
    return new RegExp(p);
  } catch {
    return null;
  }
}

/** A route as a Mønster pattern: /klip/:id → /klip/* */
export const routeToPattern = (route: string) => route.replace(/:[^/]+/g, "*");
