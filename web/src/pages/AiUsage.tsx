// /konto/forbrug — the user's own AI consumption: this month against their cap and warning levels, the budget that
// applies (and when it ends), where AI was used and the last 12 months. Only token counts exist; prompts and answers
// are never stored. Server: GET /api/ai/usage (app/consumption.py user_report).
import { Link } from "react-router-dom";
import { api } from "../api";
import { Alert, fmtNumber, Loading, PageHeader, useLoad } from "../ui";

type Policy = {
  source: "budget" | "user" | "default"; limit: number; warn_pcts: number[]; hard: boolean; used: number; pct: number | null;
  warning: number | null; status: "ok" | "warning" | "over" | "blocked" | "off"; blocked: "off" | "cap" | "total" | null;
  over_cap: boolean; total_spent: boolean;
  budget: { starts_on: string; ends_on: string | null; total_tokens: number | null; total_used: number | null } | null;
};
type Usage = {
  enabled: boolean; policy: Policy; after_budget_limit: number; month: { start: string; resets_at: string };
  days: { day: string; tokens: number }[]; surfaces: { surface: string; requests: number; tokens: number }[];
  models: { model: string; requests: number; tokens: number }[]; months: { month: string; requests: number; tokens: number }[];
  upcoming: { monthly_tokens: number; warn_pcts: number[]; hard: boolean; total_tokens: number | null; starts_on: string; ends_on: string | null }[];
};

const SURFACE: Record<string, string> = { app: "Web-appen", extension: "Browserudvidelsen", word: "Word", outlook: "Outlook", document: "Excel og PowerPoint", mobile: "Mobil", knowledge: "Viden" };
const n = (v: unknown) => Number(v ?? 0);
const day = (iso: string) => new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const monthName = (iso: string) => {
  const s = new Intl.DateTimeFormat("da-DK", { month: "long", year: "numeric" }).format(new Date(iso));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export default function AiUsage() {
  const { data, error } = useLoad(() => api.get<Usage>("/api/ai/usage"));
  const p = data?.policy;
  const pct = p && p.limit > 0 ? Math.min(100, (p.used / p.limit) * 100) : 0;
  const low = p?.warn_pcts.length ? Math.min(...p.warn_pcts) : 101;
  const barColor = pct >= 100 ? "#dc2626" : pct >= low ? "#f97316" : "#2563eb";
  const daysLeft = data ? Math.max(0, Math.ceil((new Date(data.month.resets_at).getTime() - Date.now()) / 864e5)) : 0;
  const maxDay = Math.max(1, ...(data?.days ?? []).map((d) => n(d.tokens)));
  const maxSurface = Math.max(1, ...(data?.surfaces ?? []).map((s) => n(s.tokens)));
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        <Link to="/konto" className="small">← Din konto</Link>
        <PageHeader eyebrow="Konto" title="Mit AI-forbrug">
          Hvor meget AI du har brugt, og hvad du har tilbage. Vi gemmer kun antal tokens — aldrig hvad du skrev, eller hvad AI svarede.
        </PageHeader>
      </div>
      <Alert>{error}</Alert>
      {!data && !error && <Loading />}

      {data && p && (
        <>
          {!data.enabled && <Alert kind="info">AI er ikke slået til lige nu. Dit tidligere forbrug vises herunder.</Alert>}
          {data.enabled && p.blocked === "off" && <Alert kind="info">AI er ikke slået til for din bruger. Kontakt en administrator, hvis du har brug for det.</Alert>}
          {data.enabled && p.blocked === "cap" && (
            <Alert>Du har brugt hele månedens AI-budget. AI holder pause til {day(data.month.resets_at)}. Kontakt en administrator, hvis du har brug for mere.</Alert>
          )}
          {data.enabled && p.blocked === "total" && (
            <Alert>Du har brugt hele dit AI-budget for perioden. Kontakt en administrator, hvis du har brug for mere.</Alert>
          )}
          {data.enabled && !p.blocked && p.over_cap && (
            <Alert kind="warn">Du er over månedens loft. AI virker stadig, men forbruget er markeret for din administrator.</Alert>
          )}
          {data.enabled && !p.blocked && !p.over_cap && p.warning && (
            <Alert kind="warn">
              Du har brugt {Math.floor(p.pct ?? 0)} % af månedens AI-budget.{" "}
              {p.hard ? `Når loftet er nået, holder AI pause til ${day(data.month.resets_at)}.` : "AI virker videre, også over loftet."}
            </Alert>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "stretch" }}>
            <section className="card" aria-labelledby="u-month" style={{ flex: "2 1 480px", gap: 18 }} data-deeplink="ai-usage-month">
              <div className="spread">
                <h3 id="u-month" style={{ fontSize: 20 }}>{monthName(data.month.start)}</h3>
                <span className="muted small">Nulstilles {day(data.month.resets_at)} · om {daysLeft} {daysLeft === 1 ? "dag" : "dage"}</span>
              </div>
              <div className="row" style={{ alignItems: "baseline" }}>
                <span className="num" style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em" }}>{fmtNumber(p.used)}</span>
                <span className="muted">
                  {p.limit > 0 ? `af ${fmtNumber(p.limit)} tokens · ${fmtNumber(Math.max(0, p.limit - p.used))} tilbage` : "tokens"}
                </span>
              </div>
              {p.limit > 0 && (
                <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
                  <div role="meter" aria-label="Brugt af månedens loft" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
                    style={{ position: "relative", height: 14, background: "#f1f5f9", borderRadius: 9999 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: barColor, borderRadius: 9999 }} />
                    {p.warn_pcts.map((w) => <span key={w} aria-hidden style={{ position: "absolute", left: `${w}%`, top: -3, bottom: -3, width: 2, background: "#0f172a", opacity: 0.3 }} />)}
                  </div>
                  <span className="tiny muted">
                    {Math.floor(pct)} % brugt{p.warn_pcts.length ? ` · stregerne er dine advarsler ved ${p.warn_pcts.map((w) => `${w} %`).join(", ")}` : ""}
                  </span>
                </div>
              )}
              <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
                <span className="small" style={{ fontWeight: 600 }}>Pr. dag</span>
                <div role="img" aria-label="Søjlediagram over dit forbrug pr. dag i måneden"
                  style={{ height: 120, display: "flex", alignItems: "flex-end", gap: 4, borderBottom: "1px solid #e2e8f0" }}>
                  {data.days.map((d) => (
                    <div key={d.day} title={`${day(d.day)} · ${fmtNumber(n(d.tokens))} tokens`}
                      style={{ flex: 1, minWidth: 0, height: Math.max(n(d.tokens) ? 2 : 0, Math.round((n(d.tokens) / maxDay) * 116)),
                        background: d.day > todayIso ? "#e2e8f0" : "#2563eb", borderRadius: "3px 3px 0 0" }} />
                  ))}
                </div>
                {data.days.length > 0 && (
                  <div aria-hidden className="spread tiny muted">
                    <span>{day(data.days[0].day)}</span><span>{day(data.days[data.days.length - 1].day)}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="card muted-bg" aria-labelledby="u-budget" style={{ flex: "1 1 300px", gap: 14 }} data-deeplink="ai-usage-budget">
              <h3 id="u-budget" style={{ fontSize: 20 }}>{p.source === "budget" ? "Dit budget" : "Din grænse"}</h3>
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 16px", fontSize: 14 }}>
                <dt className="muted">Loft pr. måned</dt><dd style={{ margin: 0, fontWeight: 600 }}>{p.limit > 0 ? `${fmtNumber(p.limit)} tokens` : "AI er slået fra"}</dd>
                <dt className="muted">Advarsler</dt><dd style={{ margin: 0, fontWeight: 600 }}>{p.warn_pcts.length ? p.warn_pcts.map((w) => `${w} %`).join(" · ") : "Ingen"}</dd>
                <dt className="muted">Ved loftet</dt><dd style={{ margin: 0, fontWeight: 600 }}>{p.hard ? "AI holder pause" : "Kun en advarsel"}</dd>
                {p.budget && (
                  <>
                    <dt className="muted">Periode</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{day(p.budget.starts_on)} – {p.budget.ends_on ? day(p.budget.ends_on) : "ingen slutdato"}</dd>
                  </>
                )}
                {p.budget?.total_tokens && (
                  <>
                    <dt className="muted">Samlet</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{fmtNumber(n(p.budget.total_used))} af {fmtNumber(p.budget.total_tokens)}</dd>
                  </>
                )}
              </dl>
              {p.budget?.total_tokens && (
                <div style={{ height: 8, background: "#e2e8f0", borderRadius: 9999, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, (n(p.budget.total_used) / p.budget.total_tokens) * 100)}%`, height: "100%", background: "#2563eb" }} />
                </div>
              )}
              <span className="small muted">
                {p.source === "budget"
                  ? `Budgettet er sat af en administrator.${p.budget?.ends_on ? ` Efter ${day(p.budget.ends_on)} gælder ${fmtNumber(data.after_budget_limit)} tokens pr. måned.` : ""}`
                  : p.source === "user" ? "Grænsen er sat for dig af en administrator." : "Det er standarden for alle brugere."}
              </span>
              {data.upcoming.map((b) => (
                <span key={b.starts_on} className="small">
                  Fra {day(b.starts_on)}{b.ends_on ? ` til ${day(b.ends_on)}` : ""}: {fmtNumber(b.monthly_tokens)} tokens pr. måned.
                </span>
              ))}
            </section>
          </div>

          <div className="grid" style={{ "--min": "320px" } as React.CSSProperties}>
            <section className="card" aria-labelledby="u-where">
              <h3 id="u-where" style={{ fontSize: 20 }}>Hvor du bruger AI</h3>
              {data.surfaces.length === 0 && <p className="muted small">Du har ikke brugt AI denne måned.</p>}
              {data.surfaces.map((s) => (
                <div key={s.surface} className="stack" style={{ "--gap": "4px" } as React.CSSProperties}>
                  <div className="spread small"><span>{SURFACE[s.surface] ?? s.surface}</span><span className="num muted">{fmtNumber(n(s.tokens))}</span></div>
                  <div style={{ height: 8, background: "#f1f5f9", borderRadius: 9999, overflow: "hidden" }}>
                    <div style={{ width: `${(n(s.tokens) / maxSurface) * 100}%`, height: "100%", background: "#2563eb" }} />
                  </div>
                </div>
              ))}
              {data.models.length > 0 && (
                <p className="tiny muted">Model: {data.models.map((m) => `${m.model} (${fmtNumber(n(m.tokens))})`).join(" · ")}</p>
              )}
            </section>

            <section className="card" aria-labelledby="u-hist">
              <h3 id="u-hist" style={{ fontSize: 20 }}>Seneste måneder</h3>
              {data.months.length === 0 ? <p className="muted small">Intet forbrug endnu.</p> : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr className="tiny muted" style={{ textAlign: "left" }}>
                      <th scope="col" style={{ padding: "6px 0", borderBottom: "1px solid #e2e8f0" }}>Måned</th>
                      <th scope="col" style={{ padding: "6px 0", borderBottom: "1px solid #e2e8f0", textAlign: "right" }}>Tokens</th>
                      <th scope="col" style={{ padding: "6px 0 6px 12px", borderBottom: "1px solid #e2e8f0", textAlign: "right" }}>Kald</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td style={{ padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>{monthName(m.month)}</td>
                        <td className="num" style={{ padding: "8px 0", borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{fmtNumber(n(m.tokens))}</td>
                        <td className="num" style={{ padding: "8px 0 8px 12px", borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{fmtNumber(n(m.requests))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
