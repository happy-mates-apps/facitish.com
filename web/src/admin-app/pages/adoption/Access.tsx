// /admin/adoption/access → Adgang til forløb: which admins can open Adoption (from their admin roles) and how many journeys
// they have a role in. Roles per journey are set under each journey's Opsætning.
import { Link } from "react-router-dom";
import { api } from "../../../api";
import { ErrorBox, Loading, useLoad } from "../../ui";
import { card, fmt } from "../../theme";
import { initials, useAdoption } from "./shared";

type Row = { id: number; display_name: string; admin_roles: string[]; access: "all" | "assigned" | "none"; journeys: number };

const ACCESS = {
  all: ["Alle forløb", "#166534"],
  assigned: ["Tildelte forløb", "#1d4ed8"],
  none: ["Ingen adgang", "#64748b"],
} as const;

export default function AdoptionAccess() {
  const { data, error } = useLoad(() => api.get<{ items: Row[] }>("/api/admin/adoption/access"), []);
  const { settings, journeys } = useAdoption();

  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 16 }}>
        <section style={{ ...card, flex: "3 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Admins og Adoption</h3>
              <p style={{ margin: "2px 0 0", fontSize: 13, color: "#64748b" }}>Følger af admin-rollerne Fuld adgang og Produkt — ingen særskilt onboarding</p>
            </div>
            <a href="/admin/users" style={{ fontSize: 13, fontWeight: 500 }}>Skift under Brugere og roller →</a>
          </div>
          {!data && !error && <Loading />}
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 520 }}>
              <div style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1.4fr) minmax(0,1.2fr) 130px", gap: 12, padding: "8px 0",
                borderBottom: "1px solid #e2e8f0", fontSize: 12, fontWeight: 500, color: "#64748b" }}>
                <span /><span>Admin</span><span>Admin-roller</span><span style={{ textAlign: "right" }}>Forløb</span>
              </div>
              {(data?.items ?? []).map((r) => (
                <div key={r.id} style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1.4fr) minmax(0,1.2fr) 130px", alignItems: "center", gap: 12,
                  padding: "10px 0", borderBottom: "1px solid #e2e8f0", fontSize: 13 }}>
                  <span style={{ width: 32, height: 32, borderRadius: 9999, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 600 }}>{initials(r.display_name)}</span>
                  <b style={{ fontWeight: 500 }}>{r.display_name}</b>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {r.admin_roles.map((role) => (
                      <span key={role} style={{ padding: "2px 8px", borderRadius: 9999, background: "#f1f5f9", color: "#475569", fontSize: 11, fontWeight: 600 }}>{role}</span>
                    ))}
                  </span>
                  <span style={{ textAlign: "right", color: ACCESS[r.access][1] }}>
                    {r.access === "assigned" ? `${fmt(r.journeys)} tildelt` : ACCESS[r.access][0]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section style={{ ...card, flex: "2 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10, padding: 20 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Sådan virker det</h3>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
            <li><b>Fuld adgang</b> ser og styrer alle forløb og kan slå sporingen til og fra.</li>
            <li><b>Produkt</b> ser de forløb, de har en rolle i, og kan oprette nye — så bliver de ejer.</li>
            <li>Roller i et forløb: <b>Læser</b> ser statistik, <b>Redaktør</b> ændrer opsætning og sender skub, <b>Ejer</b> styrer roller og kan slette.</li>
            <li>Et forløb har altid mindst én ejer.</li>
            <li>Sporingen er <b>{settings?.tracking ? "slået til" : "slået fra"}</b>
              {settings?.retention_days ? `; besøg slettes efter ${settings.retention_days} dage` : ""}. Besøgene er med i brugernes GDPR-indsigt.</li>
          </ul>
          {journeys && journeys.length > 0 && (
            <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
              Roller sættes under hvert forløbs <Link to={`/adoption/journeys/${journeys[0]!.id}/setup`}>Opsætning</Link>.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
