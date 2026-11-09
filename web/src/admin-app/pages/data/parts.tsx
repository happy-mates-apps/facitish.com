// Shared parts for /admin → Data: classification badge and picker.
import { CLS, CLS_KEYS, type Cls } from "./types";
import { SANS } from "../../theme";

export function ClsBadge({ value }: { value: Cls }) {
  const c = CLS[value];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.fg, border: `1px solid ${c.border}`, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: 9999, background: c.dot }} />
      {c.label}
    </span>
  );
}

export function ClsSelect({ value, onChange, label }: { value: Cls; onChange: (c: Cls) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Cls)}
      style={{ height: 30, padding: "0 6px", border: "1px solid #e2e8f0", borderRadius: 8, font: `12px ${SANS}`, background: "#ffffff" }}>
      {CLS_KEYS.map((k) => <option key={k} value={k}>{CLS[k].label}</option>)}
    </select>
  );
}
