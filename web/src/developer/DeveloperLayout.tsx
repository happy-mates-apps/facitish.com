// /developer — the developer portal: dashboard, Studio (API + MCP), the prompt catalogue and the tree examples.
// Admins with the role Data or Fuld (admin section "/developer", server/app/admin_roles.py); the API behind it is
// /api/admin/studio and the data/tool routes under /api/admin/data.
import type { CSSProperties, ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

export const SECTION = "/developer";

export function useDeveloperAccess(): "loading" | "ok" | "login" | "denied" {
  const { user, scope, loading } = useAuth();
  if (loading) return "loading";
  if (!user || scope !== "full") return "login";
  return user.role === "admin" && user.admin_sections.includes(SECTION) ? "ok" : "denied";
}

const TITLES: [RegExp, string, string][] = [
  [/^\/developer\/studio\/api/, "API Studio", "Registrér et API, test det og udstil det i datakataloget."],
  [/^\/developer\/studio\/mcp/, "MCP Studio", "Definér MCP-endpoints på /mcp/<nøgle> og vælg, hvilke værktøjer de tilbyder."],
  [/^\/developer\/studio/, "Studio", "Byg på instansen: API'er ind i kataloget, MCP-endpoints ud til AI-klienter."],
  [/^\/developer\/prompts/, "Promptkatalog", "Prompts til Claude, der støtter udviklingen af denne instans."],
  [/^\/developer\/trae/, "Træstrukturer", "Eksempler på træer og tagging i brugerfladen, mod de rigtige data i /api/meta."],
  [/^\/developer/, "Udvikler", "Overblik over API-kilder, datakatalog, MCP-endpoints og værktøjer."],
];

export function NoDeveloperAccess() {
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h2 style={{ margin: 0 }}>Kræver admin-rollen Data eller Fuld</h2>
      <p className="muted" style={{ margin: 0 }}>
        Udviklerportalen registrerer API'er i datakataloget og definerer MCP-endpoints. Det kan kun admins med rollen
        <strong> Data</strong> eller <strong>Fuld adgang</strong>. Bed en admin om rollen under /admin → Brugere og roller.
      </p>
      <a href="/" className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }}>← Til appen</a>
    </div>
  );
}

export default function DeveloperLayout({ children }: { children?: ReactNode }) {
  const access = useDeveloperAccess();
  const { pathname } = useLocation();
  const [, title, intro] = TITLES.find(([re]) => re.test(pathname)) ?? TITLES[TITLES.length - 1];
  return (
    <div className="page">
      <div className="spread" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
          <span className="eyebrow">Udvikler</span>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>{intro}</p>
        </div>
        <span className="pill mono">{pathname}</span>
      </div>
      <nav className="subnav" aria-label="Udvikler">
        <NavLink to="/developer" end>Overblik</NavLink>
        <NavLink to="/developer/studio" data-deeplink="developer-studio">Studio</NavLink>
        <NavLink to="/developer/prompts" data-deeplink="developer-prompts">Prompts</NavLink>
        <NavLink to="/developer/trae" data-deeplink="developer-trees">Træstrukturer</NavLink>
      </nav>
      {access === "loading" ? null : access === "ok" ? (children ?? <Outlet />) : <NoDeveloperAccess />}
    </div>
  );
}

/** The Studio pages share a second row of tabs: overview, API Studio, MCP Studio. */
export function StudioLayout() {
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Studio" style={{ maxWidth: 480 }}>
        <StudioTab to="/developer/studio" end>Overblik</StudioTab>
        <StudioTab to="/developer/studio/api">API Studio</StudioTab>
        <StudioTab to="/developer/studio/mcp">MCP Studio</StudioTab>
      </div>
      <Outlet />
    </>
  );
}

function StudioTab({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  const { pathname } = useLocation();
  const active = end ? pathname === to : pathname.startsWith(to);
  return (
    <NavLink to={to} end={end} role="tab" aria-selected={active}
             className={active ? "active" : undefined}
             style={{ textAlign: "center", padding: 6, borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none",
                      color: active ? "var(--hm-foreground)" : "var(--hm-muted-foreground)",
                      background: active ? "#fff" : "transparent", boxShadow: active ? "0 1px 2px rgb(0 0 0 / .08)" : undefined }}>
      {children}
    </NavLink>
  );
}
