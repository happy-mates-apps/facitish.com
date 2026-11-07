// Change the account's e-mail address or phone number: a code is sent to the new one to prove it is yours.

import { useState } from "react";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { Alert } from "../ui";

const TEXT = {
  email: { label: "E-mail", placeholder: "Ny e-mailadresse", type: "email", sentTo: "den nye adresse", done: "Din e-mailadresse er skiftet" },
  phone: { label: "Telefonnummer", placeholder: "Nyt nummer", type: "tel", sentTo: "det nye nummer", done: "Dit telefonnummer er skiftet" },
} as const;

export default function ContactChange({ kind }: { kind: "email" | "phone" }) {
  const { user, refresh } = useAuth();
  const t = TEXT[kind];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ devCode?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
      <label className="field">
        {t.label}
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input value={user?.[kind] ?? ""} placeholder="Ikke angivet" disabled style={{ flex: 1 }} />
          {!open && <button className="btn btn-outline btn-sm" type="button" onClick={() => { setOpen(true); setNotice(null); }}>{user?.[kind] ? "Skift" : "Tilføj"}</button>}
        </div>
      </label>
      {open && !sent && (
        <div className="row">
          <input type={t.type} placeholder={t.placeholder} value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary btn-sm" disabled={busy || value.trim().length < 6} onClick={() => run(async () => {
            const r = await api.post<{ dev_code?: string }>(`/api/me/${kind}/start`, { [kind]: value });
            setSent({ devCode: r.dev_code });
          })}>Send kode</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setError(null); }}>Annullér</button>
        </div>
      )}
      {open && sent && (
        <>
          <p className="small muted">Vi har sendt en kode til {t.sentTo}. Når du bekræfter, bliver du logget ud på dine andre enheder.</p>
          {sent.devCode && <Alert kind="info">Udvikling: koden er <strong className="mono">{sent.devCode}</strong></Alert>}
          <div className="row">
            <input className="mono" inputMode="numeric" maxLength={6} placeholder="Kode" value={code}
                   onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ width: 120 }} />
            <button className="btn btn-primary btn-sm" disabled={busy || code.length !== 6} onClick={() => run(async () => {
              await api.post(`/api/me/${kind}/verify`, { [kind]: value, code });
              await refresh();
              setOpen(false); setSent(null); setValue(""); setCode("");
              setNotice(t.done);
            })}>Bekræft</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSent(null); setCode(""); }}>Tilbage</button>
          </div>
        </>
      )}
      <Alert kind="success">{notice}</Alert>
      <Alert>{error}</Alert>
    </div>
  );
}
