// /admin/messages/settings → Kanaler og regler: which channels messages may use, quiet hours, limits. Providers and keys
// come from environment variables (SMS_PROVIDER, the mail provider); here they are switched on and off. Every change is
// audited (messages.settings).
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SlidersHorizontal } from "lucide-react";
import { api, errorText } from "../../../api";
import { input, label as labelStyle } from "../../theme";
import { Btn, ErrorBox, PageTitle, Toggle, useLoad, useToast } from "../../ui";
import { muted, Section, type MessageSettings } from "./shared";

export default function MessageSettingsPage() {
  const say = useToast();
  const { data, error, setData } = useLoad(() => api.get<MessageSettings>("/api/admin/messages/settings"));
  const [form, setForm] = useState<MessageSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  if (!form) return error ? <ErrorBox>{error}</ErrorBox> : null;

  const dirty = data && JSON.stringify(data) !== JSON.stringify(form);
  const set = <K extends keyof MessageSettings>(k: K, v: MessageSettings[K]) => setForm({ ...form, [k]: v });
  const num = (k: keyof MessageSettings) => (e: ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      const { sms_provider: _p, sms_sender: _s, ...values } = form;
      const r = await api.put<MessageSettings>("/api/admin/messages/settings",
        { ...values, blocked_words: values.blocked_words.map((w) => w.trim()).filter(Boolean) });
      setData({ ...r, sms_sender: form.sms_sender });
      setForm({ ...r, sms_sender: form.sms_sender });
      say("Gemt. Ændringen står i audit-loggen.");
    } catch (e) { setSaveError(errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageTitle title="Kanaler og regler" icon={<SlidersHorizontal size={24} strokeWidth={2} />}
        aside={(
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {dirty && <span style={{ fontSize: 12, color: "#92400e" }}>Ikke gemt</span>}
            <Btn kind="primary" onClick={save} disabled={busy || !dirty}>Gem ændringer</Btn>
          </div>
        )}>
        Hvilke kanaler beskeder må bruge, hvornår der er stille, og hvor meget der højst må sendes. Udbydere og nøgler kommer fra
        miljøvariabler; her slår du dem til og fra.
      </PageTitle>
      {saveError && <ErrorBox>{saveError}</ErrorBox>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))", gap: 16, alignItems: "start" }}>
        <Section title="Kanaler, i den rækkefølge de prøves">
          <Row n={1} title="SMS" note={`Kun til brugere, der selv har sagt ja til SMS-beskeder på siden Beskeder. Et telefonnummer til login er ikke et ja. Udbyder: ${form.sms_provider}.`}>
            <Toggle on={form.sms_enabled} label="SMS" onChange={() => set("sms_enabled", !form.sms_enabled)} />
          </Row>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", paddingLeft: 36 }}>
            <label style={labelStyle}>Pris pr. segment (øre)
              <input type="number" min={0} value={form.sms_price_minor} onChange={num("sms_price_minor")} style={{ ...input, width: 140 }} />
            </label>
            <label style={labelStyle}>Afsendernavn
              <input value={form.sms_sender ?? ""} disabled style={{ ...input, width: 140, background: "#f8fafc" }} />
            </label>
          </div>
          <Row n={2} title="E-mail" note="Til resten, der har en e-mailadresse og ikke har slået e-mail fra. Gennem den udgående mail.">
            <Toggle on={form.mail_enabled} label="E-mail" onChange={() => set("mail_enabled", !form.mail_enabled)} />
          </Row>
          <p style={{ margin: 0, padding: "10px 12px", borderRadius: 8, background: "#f8fafc", fontSize: 12, color: "#475569" }}>
            I appen er altid slået til: hver besked lander i indbakken på /beskeder og /m/beskeder. Push kommer i fase 3.
            Afsendernavnet rettes under <Link to="/settings">Indstillinger</Link>.
          </p>
        </Section>

        <Section title="Stilletimer">
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={labelStyle}>Fra<input type="time" value={form.quiet_start} onChange={(e) => set("quiet_start", e.target.value)} style={input} /></label>
            <label style={labelStyle}>Til<input type="time" value={form.quiet_end} onChange={(e) => set("quiet_end", e.target.value)} style={input} /></label>
            <label style={labelStyle}>Tidszone<input value={form.time_zone} onChange={(e) => set("time_zone", e.target.value)} style={{ ...input, width: 200 }} /></label>
          </div>
          <p style={{ ...muted, margin: 0, lineHeight: 1.5 }}>
            SMS i stilletimerne venter, til de slutter. Udsendelser markeret Haster går igennem. I appen og e-mail venter aldrig.
            Samme tid i Fra og Til slår stilletimer fra.
          </p>
        </Section>

        <Section title="Grænser">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <label style={labelStyle}>SMS pr. time, højst<input type="number" min={1} value={form.sms_max_per_hour} onChange={num("sms_max_per_hour")} style={input} /></label>
            <label style={labelStyle}>Dublet-vindue, sekunder<input type="number" min={0} value={form.duplicate_seconds} onChange={num("duplicate_seconds")} style={input} /></label>
            <label style={labelStyle}>»Ikke logget ind« efter, dage<input type="number" min={1} value={form.inactive_days} onChange={num("inactive_days")} style={input} /></label>
          </div>
          <p style={{ ...muted, margin: 0, fontSize: 12 }}>
            Over loftet bliver SMS registreret som Droslet og ikke sendt; en fejl i koden må ikke brænde budgettet af. Samme tekst til
            samme nummer inden for vinduet bliver en Dublet.
          </p>
        </Section>

        <Section title="Ordfilter">
          <label style={labelStyle}>Ord og mønstre, ét pr. linje
            <textarea rows={6} value={form.blocked_words.join("\n")}
              onChange={(e) => set("blocked_words", e.target.value.split("\n"))}
              style={{ ...input, height: "auto", padding: "9px 10px", font: "13px/1.5 var(--hm-font-mono)", resize: "vertical" }} />
          </label>
          <p style={{ ...muted, margin: 0, fontSize: 12 }}>
            Gælder samtaler, svar og udsendelser. Hele ord; store og små bogstaver er ligegyldige; * matcher alt, fx »tjen * om dagen«.
            Afsenderen får at vide, at beskeden ikke kan sendes. I audit-loggen står kun antallet af ord.
          </p>
        </Section>

        <Section title="Hvem må">
          <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
            Admin-rollen <strong>Support</strong> sender beskeder, besvarer svar og modererer; <strong>Privatliv</strong> modererer også; <strong>Drift</strong> ser levering og retter kanaler og
            regler. Roller tildeles under <Link to="/users">Brugere og roller</Link>. Udsendelser til alle brugere kræver en frisk passkey.
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
            Leveringer og SMS slettes efter 90 dage (<Link to="/jobs">Jobs og oprydning</Link>). Beskeder i indbakken og svar følger brugeren.
          </p>
        </Section>
      </div>
    </>
  );
}

function Row({ n, title, note, children }: { n: number; title: string; note: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span style={{ width: 24, height: 24, flex: "none", borderRadius: 9999, background: "#0f172a", color: "#fff", display: "flex",
        alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{n}</span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontWeight: 600 }}>{title}</strong><span style={{ ...muted, fontSize: 12 }}>{note}</span>
      </span>
      {children}
    </div>
  );
}
