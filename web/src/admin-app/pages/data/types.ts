// Types and small helpers for /admin → Data (specs/admin-app/DATA.md, server/app/routes/data.py).
import type { CSSProperties } from "react";

export type Cls = "white" | "green" | "yellow" | "red";

export const CLS: Record<Cls, { label: string; bg: string; fg: string; dot: string; border: string }> = {
  white: { label: "Hvid", bg: "#ffffff", fg: "#475569", dot: "#cbd5e1", border: "#cbd5e1" },
  green: { label: "Grøn", bg: "rgba(22,163,74,0.12)", fg: "#166534", dot: "#16a34a", border: "transparent" },
  yellow: { label: "Gul", bg: "rgba(249,115,22,0.12)", fg: "#9a3412", dot: "#f59e0b", border: "transparent" },
  red: { label: "Rød", bg: "rgba(220,38,38,0.1)", fg: "#b91c1c", dot: "#dc2626", border: "transparent" },
};
export const CLS_KEYS = Object.keys(CLS) as Cls[];

export type Source = { id: number | null; key: string; name: string; kind: "gaer" | "rest"; hosts: string[]; datasets: number };

export type DatasetRow = {
  id: number; source_id: number | null; key: string; name: string; description: string; classification: Cls;
  personal_data: boolean; mcp_exposed: boolean; version: number; updated_at: string; source_name: string;
  source_kind: "gaer" | "rest"; fields: number; described: number; approx_rows: number | null;
};

export type Catalog = {
  sources: Source[];
  datasets: DatasetRow[];
  stats: { datasets: number; sources: number; fields: number; described_pct: number; mcp: number; unmasks_30d: number };
};

export type Field = {
  id: number; name: string; path: string | null; label: string; description: string; data_type: string; classification: Cls; position: number;
};

export type Dataset = Omit<DatasetRow, "fields" | "described" | "approx_rows"> & {
  owner: string; source_key: string; fields: Field[]; unmasked_until: string | null;
  call: { method: string; path: string; params: Record<string, { label: string; data_type: string }> } | null;
};

export type Column = { name: string; label: string; data_type: string; classification: Cls; masked: boolean };
export type Filter = { field: string; op: string; value: string };
export type QueryResult = {
  rows: Record<string, unknown>[]; total: number | null; has_more: boolean; columns: Column[]; unmasked_until: string | null;
  filters: { field: string; where: "api" | "lokalt" }[]; source: { url: string; ms: number; cached: boolean } | null;
};

export type TableRow = { name: string; label: string; approx_rows: number; columns: number };

export const OPS: { op: string; label: string; noValue?: boolean }[] = [
  { op: "contains", label: "indeholder" },
  { op: "not_contains", label: "indeholder ikke" },
  { op: "eq", label: "er lig med" },
  { op: "neq", label: "er ikke" },
  { op: "starts_with", label: "starter med" },
  { op: "in", label: "er en af (kommasepareret)" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
  { op: "empty", label: "er tom", noValue: true },
  { op: "not_empty", label: "er ikke tom", noValue: true },
];

export const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const EXAMPLE_SPEC = `kilde: energidata
navn: Energi Data Service
type: rest                       # kun rest indtil videre
base_url: https://api.energidataservice.dk
klassifikation: hvid             # standard for felterne: hvid, grøn, gul eller rød
auth:
  type: ingen                    # ingen | bearer | header
  # hemmelighed: DATA_SECRET_ENERGIDATA  # navnet på en miljøvariabel, aldrig selve nøglen
grænser: { kald_pr_minut: 20, timeout_s: 10, cache_min: 60 }

datasæt:
  - id: elspotpriser
    navn: Elspotpriser
    kald: GET /dataset/Elspotprices
    parametre:
      start: { type: dato, navn: Fra }
      end:   { type: dato, navn: Til }
    sider:   { type: offset, parameter: offset, størrelse: limit, max: 100 }   # type: side eller type: offset
    rækker:  $.records[*]        # JSONPath til listen i svaret
    felter:
      HourDK:       { type: dato, navn: Time }
      PriceArea:    { navn: Prisområde }
      SpotPriceDKK: { type: tal, navn: Spotpris DKK/MWh }
      SpotPriceEUR: { type: tal, navn: Spotpris EUR/MWh }

  - id: co2
    navn: CO2-udledning
    kald: GET /dataset/CO2Emis
    sider:   { type: offset, parameter: offset, størrelse: limit, max: 100 }
    rækker:  $.records[*]
    felter:
      Minutes5DK:  { type: dato, navn: Tidspunkt }
      PriceArea:   { navn: Prisområde }
      CO2Emission: { type: tal, navn: g CO2/kWh }
`;
