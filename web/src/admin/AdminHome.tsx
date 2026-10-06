import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtNumber, PageHeader, useLoad } from "../ui";
import { SECTIONS } from "./sections";

type Overview = {
  users: { total: number };
  gdpr: { overdue: boolean; status: string }[];
  analytics: { totals: { pageviews: number; visitors: number } };
};

export default function AdminHome() {
  const data = useLoad<Overview>(async () => {
    const [users, gdpr, analytics] = await Promise.all([
      api.get<{ total: number }>("/api/admin/users?limit=1"),
      api.get<{ overdue: boolean; status: string }[]>("/api/admin/gdpr"),
      api.get<{ totals: { pageviews: number; visitors: number } }>("/api/admin/analytics?days=30"),
    ]);
    return { users, gdpr, analytics };
  });
  const open = data.data?.gdpr.filter((g) => g.status === "received" || g.status === "in_progress") ?? [];
  const overdue = open.filter((g) => g.overdue).length;

  return (
    <>
      <PageHeader eyebrow="/admin" title="Administration">
        Kun brugere med admin-rollen har adgang. Alt, der sker i /admin, skrives i audit-loggen.
      </PageHeader>
      <div className="grid" style={{ "--min": "200px" } as React.CSSProperties}>
        <div className="card"><span className="eyebrow">Brugere</span><span className="stat">{fmtNumber(data.data?.users.total)}</span></div>
        <div className="card"><span className="eyebrow">Sidevisninger · 30 dage</span><span className="stat">{fmtNumber(data.data?.analytics.totals.pageviews)}</span></div>
        <div className="card"><span className="eyebrow">Besøgende med samtykke</span><span className="stat">{fmtNumber(data.data?.analytics.totals.visitors)}</span></div>
        <div className={`card ${overdue ? "glow" : ""}`}>
          <span className="eyebrow">Åbne GDPR-forespørgsler</span>
          <span className="stat">{fmtNumber(open.length)}</span>
          {overdue > 0 && <span className="pill red">{overdue} over fristen</span>}
        </div>
      </div>
      <div className="grid">
        {SECTIONS.map((s) => (
          <Link key={s.path} to={s.path} className="card">
            <span className="small mono muted" style={{ fontWeight: 600 }}>{s.path}</span>
            <h3>{s.title}</h3>
            <p className="small muted">{s.text}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
