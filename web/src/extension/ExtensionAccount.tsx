import { api } from "../api";
import { useAuth } from "../auth";
import { extension, isExtension } from "../bridge/extension";
import { fmtDate, useLoad } from "../ui";

type Consent = { id: number; domain: string; created_at: string };

export default function ExtensionAccount() {
  const { user, logout } = useAuth();
  const consents = useLoad(() => api.get<Consent[]>("/api/bridge-consent"));

  return (
    <div className="stack">
      <div className="card">
        <span className="eyebrow">Logget ind som</span>
        <strong>{user?.display_name || user?.phone}</strong>
        <div className="row">
          <button className="btn btn-outline btn-sm" onClick={async () => {
            if (await isExtension()) await extension.openUrl(window.location.origin);
            else window.open("/", "_blank");
          }}>Åbn hele appen</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await logout(); window.location.href = "/extension"; }}>Log ud</button>
        </div>
      </div>
      <div className="card">
        <span className="eyebrow">Sider appen må læse</span>
        {consents.data?.length === 0 && <p className="muted small">Ingen endnu. Du bliver spurgt første gang på hvert domæne.</p>}
        {consents.data?.map((c) => (
          <div key={c.id} className="spread small">
            <span><strong>{c.domain}</strong> <span className="muted tiny">{fmtDate(c.created_at)}</span></span>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await api.del(`/api/bridge-consent/${c.id}`); await consents.reload(); }}>Fjern</button>
          </div>
        ))}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => extension.openOptions().catch(() => undefined)}>Udvidelsens indstillinger</button>
    </div>
  );
}
