// The kildebeskrivelse as a form: the server parses YAML (POST /api/admin/data/sources/parse) into this shape, and
// toYaml() writes it back. The description only ever holds names of secrets (gruppe/navn), never a value.
import type { Cls } from "../types";

export type AuthType = "ingen" | "bearer" | "header" | "basic" | "oauth2";
export type DataType = "text" | "number" | "uuid" | "date" | "boolean" | "json";

export type FieldSpec = { name: string; path: string; label: string; description: string; data_type: DataType; classification: Cls };
export type DatasetSpec = {
  key: string; name: string; description: string; classification: Cls; path: string;
  params: Record<string, { label: string; data_type: DataType }>;
  paging: { param: string; size_param: string; max: number } | null;
  rows: string; id_field: string | null; fields: FieldSpec[];
};
export type AuthSpec = {
  type: AuthType; secret: string | null; header: string | null; username: string | null;
  token_url: string | null; client_id: string | null; scope: string | null; headers: { name: string; secret: string }[];
};
export type SourceSpec = {
  key: string; name: string; base_url: string; host?: string; hosts?: string[]; auth: AuthSpec;
  limits: { per_minute: number; timeout: number; cache_min: number }; datasets: DatasetSpec[];
  classification?: Cls;
};

export const AUTH_TYPES: { type: AuthType; label: string; hint: string }[] = [
  { type: "ingen", label: "Ingen", hint: "Åbent API" },
  { type: "bearer", label: "Bearer-token", hint: "Authorization: Bearer …" },
  { type: "header", label: "API-nøgle i header", hint: "Fx X-Api-Key" },
  { type: "basic", label: "Basic", hint: "Brugernavn + adgangskode" },
  { type: "oauth2", label: "OAuth 2 · client credentials", hint: "Token hentes på serveren" },
];

export const DATA_TYPES: { type: DataType; yaml: string; label: string }[] = [
  { type: "text", yaml: "tekst", label: "Tekst" },
  { type: "number", yaml: "tal", label: "Tal" },
  { type: "uuid", yaml: "uuid", label: "UUID" },
  { type: "date", yaml: "dato", label: "Dato" },
  { type: "boolean", yaml: "bool", label: "Ja/nej" },
  { type: "json", yaml: "json", label: "JSON" },
];
const CLS_YAML: Record<Cls, string> = { white: "hvid", green: "grøn", yellow: "gul", red: "rød" };
const TYPE_YAML = Object.fromEntries(DATA_TYPES.map((d) => [d.type, d.yaml])) as Record<DataType, string>;

export const emptyAuth = (): AuthSpec => ({ type: "ingen", secret: null, header: null, username: null, token_url: null, client_id: null, scope: null, headers: [] });

export const emptyDataset = (n: number): DatasetSpec => ({
  key: `datasaet${n}`, name: `Datasæt ${n}`, description: "", classification: "yellow", path: "/", params: {}, paging: null,
  rows: "$[*]", id_field: null, fields: [{ name: "id", path: "id", label: "ID", description: "", data_type: "text", classification: "yellow" }],
});

export const emptySource = (): SourceSpec => ({
  key: "", name: "", base_url: "https://", auth: emptyAuth(), limits: { per_minute: 60, timeout: 10, cache_min: 10 },
  datasets: [emptyDataset(1)], classification: "yellow",
});

/** The secret names a description uses, with what they are used for. */
export function secretRefs(s: SourceSpec): { ref: string; usedAs: string }[] {
  const out: { ref: string; usedAs: string }[] = [];
  if (s.auth.type !== "ingen" && s.auth.secret) out.push({ ref: s.auth.secret, usedAs: "auth" });
  for (const h of s.auth.headers) if (h.secret) out.push({ ref: h.secret, usedAs: `header:${h.name}` });
  return out;
}

export const isEnvRef = (ref: string) => /^DATA_SECRET_[A-Z0-9_]+$/.test(ref);

// ── YAML ─────────────────────────────────────────────────────────────────────

/** A YAML scalar: plain when that is safe, otherwise double-quoted JSON (valid YAML). */
export function q(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (value === "") return '""';
  const plain = /^[A-Za-zÆØÅæøåÄÖÜäöüé0-9_./$\-][^:#{}[\],&*!|>'"%@`]*$/.test(value) && !/\s$/.test(value)
    && !/^(true|false|null|yes|no|on|off|~|-?\d[\d_.eE+-]*)$/i.test(value) && !value.includes(": ");
  return plain && !value.startsWith("- ") ? value : JSON.stringify(value);
}

function flow(obj: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${q(v as string)}`);
  return `{ ${parts.join(", ")} }`;
}

export function toYaml(s: SourceSpec): string {
  const L: string[] = [];
  L.push(`kilde: ${q(s.key)}`, `navn: ${q(s.name)}`, "type: rest", `base_url: ${q(s.base_url)}`);
  if (s.classification) L.push(`klassifikation: ${CLS_YAML[s.classification]}`);
  const a = s.auth;
  L.push("auth:", `  type: ${a.type}`);
  if (a.type === "header" && a.header) L.push(`  header: ${q(a.header)}`);
  if (a.type === "basic" && a.username) L.push(`  brugernavn: ${q(a.username)}`);
  if (a.type === "oauth2") {
    if (a.token_url) L.push(`  token_url: ${q(a.token_url)}`);
    if (a.client_id) L.push(`  client_id: ${q(a.client_id)}`);
    if (a.scope) L.push(`  scope: ${q(a.scope)}`);
  }
  if (a.type !== "ingen") L.push(`  hemmelighed: ${q(a.secret ?? "")}   # navnet i Hemmeligheder, aldrig værdien`);
  if (a.headers.length) {
    L.push("  headers:");
    for (const h of a.headers) L.push(`    ${h.name}: { hemmelighed: ${q(h.secret)} }`);
  }
  L.push(`grænser: ${flow({ kald_pr_minut: s.limits.per_minute, timeout_s: s.limits.timeout, cache_min: s.limits.cache_min })}`, "", "datasæt:");
  for (const d of s.datasets) {
    L.push(`  - id: ${q(d.key)}`, `    navn: ${q(d.name)}`);
    if (d.description) L.push(`    beskrivelse: ${q(d.description)}`);
    L.push(`    kald: GET ${d.path}`);
    if (s.classification && d.classification !== s.classification) L.push(`    klassifikation: ${CLS_YAML[d.classification]}`);
    const params = Object.entries(d.params);
    if (params.length) {
      L.push("    parametre:");
      for (const [name, p] of params) L.push(`      ${name}: ${flow({ type: TYPE_YAML[p.data_type], navn: p.label })}`);
    }
    if (d.paging) L.push(`    sider: ${flow({ type: "side", parameter: d.paging.param, "størrelse": d.paging.size_param, max: d.paging.max })}`);
    L.push(`    rækker: ${q(d.rows)}`);
    if (d.id_field) L.push(`    nøgle: ${q(d.id_field)}`);
    L.push("    felter:");
    for (const f of d.fields) {
      L.push(`      ${f.name}: ${flow({
        sti: f.path !== f.name ? f.path : null, type: f.data_type !== "text" ? TYPE_YAML[f.data_type] : null, navn: f.label,
        beskrivelse: f.description, klassifikation: f.classification !== d.classification ? CLS_YAML[f.classification] : null,
      })}`);
    }
  }
  return L.join("\n") + "\n";
}

/** The server's parse result → the form's shape (the dataset's call is "GET /path"). */
export function fromParsed(p: SourceSpec & { datasets: (DatasetSpec & { method?: string })[] }): SourceSpec {
  const counts: Record<string, number> = {};
  for (const d of p.datasets) counts[d.classification] = (counts[d.classification] ?? 0) + 1;
  const common = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "yellow") as Cls;
  return {
    key: p.key, name: p.name, base_url: p.base_url, host: p.host, hosts: p.hosts, auth: { ...emptyAuth(), ...p.auth, headers: p.auth.headers ?? [] },
    limits: p.limits, classification: common,
    datasets: p.datasets.map((d) => ({
      key: d.key, name: d.name, description: d.description ?? "", classification: d.classification, path: d.path, params: d.params ?? {},
      paging: d.paging, rows: d.rows, id_field: d.id_field, fields: d.fields.map((f) => ({ ...f, description: f.description ?? "" })),
    })),
  };
}

export function slug(text: string, fallback = "datasaet"): string {
  const s = text.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z0-9]/.test(s) ? s : fallback;
}

export function fieldName(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  return /^[A-Za-z_]/.test(s) ? s : `f_${s}`.slice(0, 63);
}
