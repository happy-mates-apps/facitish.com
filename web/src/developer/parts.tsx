// Small shared pieces for the developer portal.
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmtDate, fmtNumber } from "../ui";

export const MONO: CSSProperties = { fontFamily: "var(--hm-font-mono)" };
export const gap = (px: number): CSSProperties => ({ "--gap": `${px}px` } as CSSProperties);

export function Kpi({ label, value, hint, to }: { label: string; value: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="stat">{value}</span>
      {hint && <span className="tiny muted">{hint}</span>}
    </>
  );
  return to ? <Link to={to} className="kpi" style={{ textDecoration: "none" }}>{body}</Link> : <div className="kpi">{body}</div>;
}

export function Calls({ calls, errors }: { calls: number; errors: number }) {
  return (
    <span className="small num" title="Kald og fejl de seneste 7 dage">
      {fmtNumber(calls)} kald{errors > 0 && <span style={{ color: "#b91c1c" }}> · {fmtNumber(errors)} fejl</span>}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === "ok" || status === "confirmed" ? "green" : status === "draft" || status === "cancelled" ? "amber" : "red";
  return <span className={`pill ${tone}`}>{status}</span>;
}

export function When({ value }: { value: string | null | undefined }) {
  return <span className="tiny muted num">{value ? fmtDate(value) : "—"}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card muted-bg" style={{ textAlign: "center" }}><p className="muted" style={{ margin: 0 }}>{children}</p></div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="spread">
      <h2 style={{ margin: 0, fontSize: 18 }}>{children}</h2>
      {action}
    </div>
  );
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
