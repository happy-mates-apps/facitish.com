// Types for the developer portal on /developer (server/app/routes/studio.py and the data/tool routes it reuses).

export type EndpointSummary = {
  key: string; path: string; url: string; name: string; description: string; instructions: string;
  audience: "all" | "internal" | "admin"; audienceLabel: string; enabled: boolean; builtin: boolean; scope: string;
  live: boolean; tools: number; calls7d: number; errors7d: number; callers7d: number; lastAt: string | null;
  createdAt: string; updatedAt: string;
};

export type SourceSummary = {
  id: number; key: string; name: string; host: string | null; datasets: number; updatedAt: string;
  calls7d: number; errors7d: number; lastAt: string | null;
};

export type RecentCall = {
  ts: string; endpoint: string; path: string; tool: string | null; status: string; ms: number | null; who: string | null;
};

export type Overview = {
  sources: { count: number; calls7d: number; errors7d: number; items: SourceSummary[] };
  catalog: { datasets: number; fromApi: number; mcpExposed: number };
  tools: { total: number; data: number; code: number; disabled: number };
  endpoints: { count: number; dynamic: number; calls7d: number; errors7d: number; clients: number; items: EndpointSummary[] };
  recent: RecentCall[];
  origin: string;
};

export type ToolParam = { name: string; type: "int" | "string" | "bool" | "date"; desc?: string; optional?: boolean };
export type ToolSpec = {
  name: string; description: string; mode: "read" | "write" | "draft" | "confirm"; domain: string; params: ToolParam[];
  kind: "code" | "data"; classification: string; toolId: number; inputSchema: unknown; link: unknown;
};

/** A row of the endpoint map (/api/admin/data/tools), as toolmap.out() returns it. */
export type MapTool = {
  id: number; name: string; kind: "code" | "data"; title: string; description: string; classification: string;
  classificationLabel: string; datasetId: number | null; datasetName: string | null; enabled: boolean;
  endpoints: string[]; possibleEndpoints: string[]; core: boolean; requestLevel: string | null;
};

export type EndpointDetail = {
  endpoint: EndpointSummary;
  tools: ToolSpec[];
  available: MapTool[];
  datasets: { id: number; name: string; key: string; classification: string; personal_data: boolean; source: string | null }[];
  clients: { name: string; sessions: number; last_seen_at: string | null }[];
  core: string[];
  starter: string[];
  connect: { url: string; scope: string; metadata: string; authorization: string; token: string; register: string };
};

export type EndpointList = {
  endpoints: EndpointSummary[]; audiences: { id: string; label: string }[]; reserved: string[]; origin: string;
};

export type LogItem = {
  ts: string; method: string; tool: string | null; status: string; ms: number | null; client: string | null; who: string | null;
};

// ── Data (routes/data.py) ───────────────────────────────────────────────────

export type CatalogSource = { id: number | null; key: string; name: string; kind: "gaer" | "rest"; hosts: string[]; datasets: number };
export type Catalog = { sources: CatalogSource[]; datasets: { id: number; source_id: number | null; key: string; name: string }[] };

export type SourceDetail = {
  id: number; key: string; name: string; kind: string; spec_yaml: string; hosts: string[]; updated_at: string;
  datasets: { id: number; key: string; name: string }[];
  secrets: { ref: string; used_as: string[]; ok: boolean; text: string }[];
};

export type TestResult = {
  source: { key: string; name: string; host: string; hosts: string[]; auth: string };
  secrets: { ref: string; ok: boolean; text: string }[];
  datasets: { key: string; name: string; call: string; fields: number; paged: boolean }[];
  preview: { dataset: string; url: string; ms: number; rows: Record<string, unknown>[]; columns: { name: string; label: string; masked: boolean }[] } | null;
  error: string | null;
  checks: { ok: boolean; text: string }[];
};
