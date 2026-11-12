// /admin/settings → Tilmelding: who may create an account by logging in (server/app/signup.py). Existing users can
// always log in, and the first admin of a new instance always gets in. The login page answers the same for every
// e-mail, so it never reveals who has an account.
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { Alert, useLoad } from "../ui";

type Mode = "open" | "domains" | "closed";
type Signup = { mode: Mode; domains: string[]; contact: string };

const MODES: [Mode, string, string][] = [
  ["open", "Åben", "Alle, der logger ind med en ny e-mail, får en konto som bruger."],
  ["domains", "Kun bestemte domæner", "Kun e-mails på domænerne herunder kan oprette sig selv. Alle andre skal oprettes af en admin."],
  ["closed", "Lukket", "Kun brugere, som en admin har oprettet under Brugere og roller, kan logge ind."],
];

export default function SettingsSignup() {
  const data = useLoad(() => api.get<Signup>("/api/admin/settings/signup"));
  const [form, setForm] = useState<Signup>({ mode: "open", domains: [], contact: "" });
  const [domains, setDomains] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data.data) {
      setForm(data.data);
      setDomains(data.data.domains.join(", "));
    }
  }, [data.data]);

  const list = domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
  const dirty = !!data.data && (form.mode !== data.data.mode || form.contact !== data.data.contact || list.join() !== data.data.domains.join());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const saved = await api.put<Signup>("/api/admin/settings/signup", { ...form, domains: form.mode === "domains" ? list : data.data?.domains ?? [] });
      setForm(saved);
      setDomains(saved.domains.join(", "));
      await data.reload();
      setNotice("Tilmeldingen er gemt. Ændringen er skrevet i audit-loggen.");
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!data.data) return data.error ? <Alert>{data.error}</Alert> : null;
  return (
    <form className="card" id="tilmelding" data-deeplink="setting-signup" onSubmit={save}>
      <span className="eyebrow">Tilmelding</span>
      <p className="muted small" style={{ margin: 0 }}>
        Bestem om folk selv kan oprette en konto ved at logge ind med deres e-mail, eller om en admin skal oprette dem først.
        Eksisterende brugere kan altid logge ind.
      </p>
      <Alert kind="success">{notice}</Alert>
      <Alert>{error}</Alert>
      <fieldset className="stack" style={{ "--gap": "8px", border: 0, margin: 0, padding: 0 } as React.CSSProperties}>
        <legend className="small" style={{ fontWeight: 600, paddingBottom: 6 }}>Hvem må oprette sig selv</legend>
        {MODES.map(([key, label, text]) => {
          const on = form.mode === key;
          return (
            <label key={key} className="row" style={{ "--gap": "12px", alignItems: "flex-start", padding: "12px 14px", borderRadius: 10, cursor: "pointer",
              border: on ? "2px solid #2563eb" : "1px solid var(--hm-border)", background: on ? "#eff6ff" : "#ffffff" } as React.CSSProperties}>
              <input type="radio" name="signup" checked={on} onChange={() => setForm({ ...form, mode: key })} style={{ marginTop: 3 }} />
              <span className="stack" style={{ "--gap": "4px", flex: 1 } as React.CSSProperties}>
                <strong>{label}</strong>
                <span className="muted small">{text}</span>
                {key === "domains" && on && (
                  <label className="field" style={{ marginTop: 6 }}>Domæner (adskilt af komma)
                    <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="firma.dk, datterselskab.dk" />
                    <span className="muted tiny">Underdomæner tæller med: firma.dk dækker også afd.firma.dk.</span>
                  </label>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className="field">Kontakt for dem uden konto (vises på login-siden, når tilmelding ikke er åben)
        <input value={form.contact} maxLength={200} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="support@firma.dk" />
      </label>
      <p className="muted tiny" style={{ margin: 0 }}>
        Login-siden svarer det samme, uanset om e-mailen findes, så den ikke afslører, hvem der har en konto. Der sendes kun en kode til
        e-mails, der må logge ind. På en ny instans uden brugere kan den første stadig logge ind og blive superadmin.
      </p>
      <div className="row"><button className="btn btn-primary" disabled={!dirty}>Gem tilmelding</button></div>
    </form>
  );
}
