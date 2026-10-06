import { NavLink, Outlet } from "react-router-dom";
import { SECTIONS } from "./sections";

export default function AdminLayout() {
  return (
    <div className="admin">
      <aside className="admin-side">
        <NavLink to="/admin" end>
          Overblik<span>/admin</span>
        </NavLink>
        {SECTIONS.map((s) => (
          <NavLink key={s.path} to={s.path}>
            {s.title}
            <span>{s.path}</span>
          </NavLink>
        ))}
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
