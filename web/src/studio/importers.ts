// Turning an OpenAPI document or a cURL command into a kildebeskrivelse. Runs in the browser on text the admin pastes;
// nothing is fetched. A key found in a cURL command is never kept: the admin picks a secret from Hemmeligheder instead.
import { type AuthSpec, type Cls, type DataType, type DatasetSpec, type FieldSpec, emptyAuth, fieldName, slug } from "./spec";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export type OpenApiOp = {
  id: string; path: string; summary: string; params: DatasetSpec["params"]; rows: string; fields: FieldSpec[]; paged: boolean;
};
export type OpenApiResult = { title: string; base_url: string | null; auth: AuthSpec | null; authNote: string | null; ops: OpenApiOp[]; skipped: number };

const MAX_FIELDS = 80;

function resolve(doc: Json, node: unknown, depth = 0): Json {
  let n = obj(node);
  for (let i = 0; i < 10 && typeof n.$ref === "string"; i++) {
    const ref = n.$ref as string;
    if (!ref.startsWith("#/")) return {};
    n = obj(ref.slice(2).split("/").reduce<unknown>((acc, k) => obj(acc)[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc));
  }
  if (depth < 4 && Array.isArray(n.allOf)) {
    const merged: Json = { type: "object", properties: {} };
    for (const part of n.allOf) Object.assign(merged.properties as Json, obj(resolve(doc, part, depth + 1).properties));
    return merged;
  }
  return n;
}

function dataType(schema: Json): DataType {
  const t = schema.type, f = schema.format;
  if (t === "integer" || t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (f === "uuid") return "uuid";
  if (f === "date" || f === "date-time") return "date";
  if (t === "object" || t === "array") return "json";
  return "text";
}

function guessClass(name: string): Cls {
  const n = name.toLowerCase();
  if (/(e-?mail|phone|telefon|cpr|ssn|password|birth|fødsel)/.test(n)) return "red";
  if (/(name|navn|address|adresse|ip)/.test(n)) return "yellow";
  return "yellow";
}

function fieldsOf(doc: Json, schema: Json): FieldSpec[] {
  const out: FieldSpec[] = [];
  const walk = (s: Json, prefix: string, depth: number) => {
    for (const [key, raw] of Object.entries(obj(s.properties))) {
      if (out.length >= MAX_FIELDS || !/^[A-Za-z0-9_]+$/.test(key)) continue;
      const p = resolve(doc, raw);
      const path = prefix ? `${prefix}.${key}` : key;
      if (p.type === "object" && p.properties && depth < 2) {
        walk(p, path, depth + 1);
        continue;
      }
      out.push({ name: fieldName(path.replace(/\./g, "_")), path, label: String(p.title ?? ""), description: String(p.description ?? "").slice(0, 500),
                 data_type: dataType(p), classification: guessClass(key) });
    }
  };
  walk(schema, "", 0);
  return out;
}

/** Where the rows are in a response: $[*] for a list, $.items[*] for {items: [...]}, $ for one object. */
function rowsOf(doc: Json, schema: Json): { rows: string; item: Json } {
  if (schema.type === "array") return { rows: "$[*]", item: resolve(doc, schema.items) };
  for (const [key, raw] of Object.entries(obj(schema.properties))) {
    const p = resolve(doc, raw);
    if (p.type === "array" && /^[A-Za-z0-9_]+$/.test(key)) return { rows: `$.${key}[*]`, item: resolve(doc, p.items) };
  }
  return { rows: "$", item: schema };
}

function authOf(doc: Json, spec: Json): { auth: AuthSpec | null; note: string | null } {
  const schemes = obj(obj(spec.components).securitySchemes ?? spec.securityDefinitions);
  for (const [name, raw] of Object.entries(schemes)) {
    const s = obj(raw);
    const a = emptyAuth();
    if (s.type === "http" && String(s.scheme).toLowerCase() === "bearer") return { auth: { ...a, type: "bearer" }, note: `Fra ${name}: bearer-token` };
    if ((s.type === "http" && String(s.scheme).toLowerCase() === "basic") || s.type === "basic") return { auth: { ...a, type: "basic", username: "" }, note: `Fra ${name}: basic` };
    if (s.type === "apiKey" && s.in === "header") return { auth: { ...a, type: "header", header: String(s.name) }, note: `Fra ${name}: nøgle i ${String(s.name)}` };
    const cc = obj(obj(s.flows).clientCredentials);
    if (s.type === "oauth2" && cc.tokenUrl) {
      const scopes = Object.keys(obj(cc.scopes));
      return { auth: { ...a, type: "oauth2", token_url: String(cc.tokenUrl), client_id: "", scope: scopes.join(" ") || null }, note: `Fra ${name}: OAuth 2` };
    }
  }
  void doc;
  return { auth: null, note: null };
}

export function parseOpenApi(text: string): OpenApiResult {
  let doc: Json;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Indsæt OpenAPI-dokumentet som JSON (de fleste API'er har en /openapi.json).");
  }
  if (!doc.openapi && !doc.swagger) throw new Error("Det ligner ikke et OpenAPI-dokument (mangler openapi eller swagger).");
  const server = obj((doc.servers as unknown[] | undefined)?.[0]).url;
  let base: string | null = typeof server === "string" ? server.replace(/\/$/, "") : null;
  if (!base && doc.host) base = `https://${String(doc.host)}${String(doc.basePath ?? "").replace(/\/$/, "")}`;
  if (base && !base.startsWith("https://")) base = null;
  const ops: OpenApiOp[] = [];
  let skipped = 0;
  for (const [path, rawItem] of Object.entries(obj(doc.paths))) {
    const item = obj(rawItem);
    const get = obj(item.get);
    if (!item.get) continue;
    if (/[?#{]|\.\./.test(path)) {
      skipped++; // a path parameter ({id}) cannot be a dataset yet
      continue;
    }
    const params: DatasetSpec["params"] = {};
    let paged = false;
    for (const raw of [...((item.parameters as unknown[]) ?? []), ...((get.parameters as unknown[]) ?? [])]) {
      const p = resolve(doc, raw);
      if (p.in !== "query" || typeof p.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(p.name)) continue;
      params[p.name] = { label: String(p.description ?? p.name).slice(0, 80), data_type: dataType(resolve(doc, p.schema ?? p)) };
      if (/^(page|side|offset|cursor)$/i.test(p.name)) paged = true;
    }
    const responses = obj(get.responses);
    const ok = resolve(doc, responses["200"] ?? responses["201"] ?? responses.default);
    const schema = resolve(doc, obj(obj(obj(ok.content)["application/json"]).schema ?? ok.schema));
    const { rows, item: rowSchema } = rowsOf(doc, schema);
    const fields = fieldsOf(doc, rowSchema);
    const id = slug(String(get.operationId ?? path.replace(/[{}]/g, "")), `get-${ops.length + 1}`);
    ops.push({ id, path, summary: String(get.summary ?? get.description ?? "").slice(0, 120), params, rows, fields, paged });
  }
  const { auth, note } = authOf(doc, doc);
  return { title: String(obj(doc.info).title ?? ""), base_url: base, auth, authNote: note, ops, skipped };
}

export function opToDataset(op: OpenApiOp, cls: Cls): DatasetSpec {
  return {
    key: op.id.slice(0, 40), name: op.summary || op.path, description: "", classification: cls, path: op.path,
    params: op.params, paging: null, rows: op.rows, id_field: op.fields.some((f) => f.name === "id") ? "id" : null,
    fields: op.fields.length ? op.fields : [{ name: "id", path: "id", label: "ID", description: "", data_type: "text", classification: cls }],
  };
}

// ── cURL ─────────────────────────────────────────────────────────────────────

function shellWords(text: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  const src = text.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < src.length) cur += src[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < src.length) {
      cur += src[++i];
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export type CurlResult = {
  base_url: string; path: string; params: DatasetSpec["params"]; auth: AuthSpec; notes: string[]; method: string;
};

export function parseCurl(text: string): CurlResult {
  const words = shellWords(text.trim());
  if (words[0] !== "curl") throw new Error("Kommandoen skal starte med curl");
  let url = "", method = "GET";
  const headers: [string, string][] = [];
  let user: string | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-H" || w === "--header") {
      const h = words[++i] ?? "";
      const at = h.indexOf(":");
      if (at > 0) headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
    } else if (w === "-u" || w === "--user") user = words[++i] ?? "";
    else if (w === "-X" || w === "--request") method = (words[++i] ?? "GET").toUpperCase();
    else if (["-d", "--data", "--data-raw", "--data-binary", "--json", "-F", "--form"].includes(w)) {
      i++;
      if (method === "GET") method = "POST";
    } else if (w === "--url") url = words[++i] ?? "";
    else if (!w.startsWith("-") && !url) url = w;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Fandt ingen adresse i kommandoen");
  }
  if (u.protocol !== "https:") throw new Error("Adressen skal være https");
  const notes: string[] = [];
  if (method !== "GET") notes.push(`Kommandoen bruger ${method}. Kun GET kan blive til et datasæt; den er lavet om til GET.`);
  const params: DatasetSpec["params"] = {};
  u.searchParams.forEach((_, k) => {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(k) && !/(key|token|secret|signature)/i.test(k)) params[k] = { label: k, data_type: "text" };
    else if (/(key|token|secret|signature)/i.test(k)) notes.push(`Parameteren ${k} ligner en nøgle og er ikke taget med. Brug en hemmelighed i en header i stedet.`);
  });
  const auth = emptyAuth();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "authorization" && /^bearer\s/i.test(value)) {
      auth.type = "bearer";
      notes.push("Bearer-tokenet er ikke gemt. Vælg hemmeligheden i Hemmeligheder.");
    } else if (lower === "authorization" && /^basic\s/i.test(value)) {
      auth.type = "basic";
      try {
        auth.username = atob(value.split(/\s+/)[1] ?? "").split(":")[0] || null;
      } catch {
        auth.username = null;
      }
      notes.push("Adgangskoden er ikke gemt. Vælg hemmeligheden i Hemmeligheder.");
    } else if (/(api[-_]?key|token|secret|auth)/i.test(lower) && /^[A-Za-z0-9-]+$/.test(name)) {
      if (auth.type === "ingen") {
        auth.type = "header";
        auth.header = name;
      } else auth.headers.push({ name, secret: "" });
      notes.push(`Værdien i ${name} er ikke gemt. Vælg hemmeligheden i Hemmeligheder.`);
    }
  }
  if (user !== null) {
    auth.type = "basic";
    auth.username = user.split(":")[0] || null;
    notes.push("Adgangskoden fra -u er ikke gemt. Vælg hemmeligheden i Hemmeligheder.");
  }
  return { base_url: u.origin, path: u.pathname || "/", params, auth, notes, method };
}
