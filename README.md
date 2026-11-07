# Gær — Surdej i letvægt

Én container med en Python-server og en Vite-frontend, koblet til managed Postgres og Object Storage på
OVHcloud. Login med telefonnummer og engangskode, passkey efter tre logins, og fuld audit- og auth-log.

Gær-base er skabelonen. Hver kunde får altid en fork i sin egen GitHub-organisation og henter opdateringer
herfra ind i sin fork.

## Indhold

| | |
| --- | --- |
| **Login** | Telefonnummer → engangskode på SMS (gemt som hash, udløber, kan bruges én gang, spærring efter for mange forsøg). Tre grace logins, derefter passkey. Ny enhed: kode + ny passkey, tæller ikke som grace login. Første bruger bliver admin — eller, med `BOOTSTRAP_ADMIN_PHONE`, kun det nummer (anbefalet i produktion). |
| **Logning** | Auth-log og audit-log i Postgres. Kun tilføjelse: app-brugeren har ikke UPDATE/DELETE, og en trigger stopper UPDATE. Sletning kun fra /admin med en separat databasebruger, og sletningen logges. |
| **/admin** | Brugere og roller · auth-log · audit-log (CSV) · analytics · heatmaps · GDPR-forespørgsler · sletning af logdata · samtykke og cookies · filer · website · udvidelse og Office · indstillinger. Alt i /admin skrives i audit-loggen. |
| **Analytics og heatmaps** | Opsamles af Python-serveren og gemmes i en partitioneret tabel i containerens egen database. Ingen tredjepart. Kun anonyme sidevisninger uden samtykke. |
| **Filer** | Object Storage. Upload gennem serveren, download via links, der udløber efter få minutter. |
| **/w** | Offentligt website, server-renderet fra Markdown-sider på dansk og engelsk. Anonyme besøgende på `/` sendes hertil. |
| **/m** | Mobil-app (PWA) med bundmenu, kamera-upload og klip. |
| **/extension** | Browserudvidelse (Chrome/Edge sidepanel), der kan læse den aktuelle side og gemme den som klip — med samtykke pr. domæne. |
| **/office-addin** | Office-tilføjelser til Word, Excel, PowerPoint og Outlook. Én router finder værten og viser det rigtige værktøj: indsæt klip, gem markering eller mail som klip, svar med klip. |
| **AI-chat (valgfri)** | Chat i browserudvidelsen (med siden som kontekst), Word og Outlook (med dokumentet/mailen som kontekst; AI'en kan indsætte tekst, sætte emne, åbne svar) og /m. Bruger OVHcloud AI Endpoints, så teksten behandles i Europa. Slås til med `AI_API_KEY`. Samtaler gemmes ikke; kun forbrug, med en månedlig kvote pr. bruger i /admin/ai. |
| **AI-udvikling** | Skills og slash commands til Claude Code og GitHub Copilot: `/gaer-boot`, `/gaer-init`, `/gaer-dev`, `/gaer-db`, `/gaer-mix`, `/gaer-new-feature`, `/gaer-pr`, `/gaer-pr-review`, `/gaer-release`, `/gaer-recover`, `/gaer-whatsup`. |

## Ruter

Én server og ét domæne. Stien afgør, hvilken flade der svarer. Alle deler login, database og API.

| Rute | Hvem | Hvad |
| --- | --- | --- |
| `/` | logget ind | Appens forside. Anonyme sendes til `/w/`. |
| `/w/…` | alle | Offentligt website (Markdown fra `/admin/web`, dansk/engelsk). Forsiden har altid et login-kort; på en ny instans står der, at den første, der logger ind, bliver administrator. |
| `/login` | anonyme | Telefonnummer → engangskode → passkey. Viser, når man bliver den første admin. |
| `/klip`, `/filer`, `/konto`, `/privatliv` | logget ind | Klip, filer, konto og passkeys, privatliv og GDPR. |
| `/admin/…` | admin | Administration. Alt logges. |
| `/m/…` | logget ind | Mobil-app (PWA) med bundmenu, AI, klip, filer og profil. |
| `/extension/…` | i browserudvidelsen | Sidepanelet: aktuel side, klip og AI med siden som kontekst. |
| `/office-addin` | Office | Router for Word, Excel, PowerPoint og Outlook → værktøjerne under `/extension/tools/…`. |
| `/api/…` | | JSON-API. |
| `/health` | udrulning | Sundhedstjek. |

## GDPR

| Ret | Hvordan |
| --- | --- |
| **Samtykke** | Cookie-banner i appen og på `/w`. Uden samtykke kun anonyme sidevisninger; med samtykke et tilfældigt id til besøg, forløb og heatmaps. Kan ændres på `/privatliv`. Tekster og overblik i `/admin/consent`. |
| **Indsigt** | Brugeren henter selv en zip på `/privatliv` (data.json + egne filer). Admin kan gøre det samme fra en anmodning i `/admin/gdpr`. Eksporten logges. |
| **Rettelse** | Navn på `/konto`. Telefonnummer på `/konto` med kode til det nye nummer, eller af admin i `/admin/users` (“Ret nummer”). |
| **Sletning** | Brugeren sletter selv sin konto på `/privatliv`, eller admin sletter fra en anmodning. Brugeren, filer, klip, passkeys, sessioner, AI-forbrug, samtykker, statistik og log-data om brugeren slettes. Tilbage bliver kun en notits uden persondata (`gdpr.erasure`, `log.purged`). Den sidste admin kan ikke slettes. |
| **Anmodninger** | Indsigt, rettelse og sletning kan sendes fra `/privatliv`, også uden login. `/admin/gdpr` viser frist (30 dage) og status. |
| **Opbevaring** | Logs slettes automatisk efter perioderne i `/admin/retention`. |
| **Backups** | Managed PostgreSQL tager automatiske backups. Slettede data forsvinder fra dem, når backuppen udløber (se OVHcloud-planens opbevaringstid). Gendannes en backup, skal sletninger efter backup-tidspunktet gentages, før databasen tages i brug: `python -m app.reapply_erasures --from-url "$GAMMEL_DATABASE_URL" --since <backup-tidspunkt>` (se `/gaer-recover`). |

Alle tabeller med persondata skal med i `server/app/gdpr.py` — både i eksporten og i sletningen.

## Kom i gang lokalt

Kræver Python 3.12+, Node 22 og Docker.

```bash
cp .env.example .env
python -m venv .venv && . .venv/bin/activate && pip install -r server/requirements-dev.txt
npm ci --prefix web
docker compose up -d                                   # Postgres + MinIO
(cd server && python -m app.migrate)
(cd server && uvicorn app.main:app --reload --port 8000 --env-file ../.env) &
npm run dev --prefix web                               # http://localhost:5173
```

Med `SMS_PROVIDER=console` står engangskoden i serverens log og på login-siden. Den første bruger bliver admin.
Websitet `/w/` serveres af Python-serveren: http://localhost:8000/w/.

### Test

```bash
TEST_DATABASE_ADMIN_URL=postgresql://gaer:gaer@localhost:5432/gaer pytest server
npm run build --prefix web
```

Testene opretter en midlertidig database med samme brugere som i produktion (`_app`, `_purge`), så
rettighederne på log-tabellerne bliver testet. Passkeys testes med en software-authenticator.

## Arkitektur

```
           Caddy (TLS, Let's Encrypt)
                     │
        ┌────────────▼────────────┐
        │  Container  gaer        │        OVHcloud · managed
        │  ┌───────────────────┐  │     ┌──────────────────────────────┐
        │  │ Python (FastAPI)  │──┼────►│ PostgreSQL-cluster (fælles)  │
        │  │  /api  /w  /health│  │     │  gaer_<kunde>  ← egen db     │
        │  │  serverer web/dist│──┼──┐  └──────────────────────────────┘
        │  └───────────────────┘  │  │  ┌──────────────────────────────┐
        └─────────────────────────┘  └─►│ Object Storage (S3)          │
                                        └──────────────────────────────┘
```

Tre databasebrugere pr. container, oprettet med `deploy/provision_database.py`:

| Bruger | Miljøvariabel | Rettigheder |
| --- | --- | --- |
| `gaer_<navn>_owner` | `MIGRATION_DATABASE_URL` | ejer skemaet, kører migrationer |
| `gaer_<navn>_app` | `DATABASE_URL` | appen; kun SELECT/INSERT på log-tabeller |
| `gaer_<navn>_purge` | `PURGE_DATABASE_URL` | sletning af logdata fra /admin |

Ingen af dem kan forbinde til andre containeres databaser.

## Udrulning

Push til `main` → `.github/workflows/deploy.yml`:

1. Test (Python mod Postgres, build af frontend)
2. Byg ét image, tagget med commit-sha, og push til GitHub Container Registry (`ghcr.io`)
3. Kopiér `deploy/compose.yml`, `deploy/postgres-init.sh` og `deploy/deploy.sh` til `~/gaer` på UpCloud-serveren
4. `deploy.sh release`: start Postgres, migrér databasen, start den nye version med `docker compose`.
   Svarer `/health` ikke inden for 60 sekunder, startes den forrige version igen.
   `deploy.sh rollback` starter den forrige version.

Stakken (`deploy/compose.yml`) er Postgres (egen database med de tre brugere), appen og `cloudflared`,
som sender trafik ind via en Cloudflare Tunnel — serveren har ingen åbne web-porte.

GitHub-environment **production** skal have secrets `HOST` (serverens IP), `SSH_KEY` (privat deploy-nøgle
til brugeren `deploy`) og `SSH_KNOWN_HOSTS` (`ssh-keyscan <host>`), samt variablen `DOMAIN` (smoke test).
På serveren laves `~/gaer/.env` ud fra `deploy/.env.example` og `~/gaer/app.env` ud fra
`deploy/app.env.example`.

## Browserudvidelse og Office

- **Udvidelse**: hent den i `/admin/integrations` (zip med instansens adresse), indlæs upakket i
  `chrome://extensions`, eller udgiv mappen `extension/` i Chrome Web Store / Edge Add-ons.
- **Office**: hent manifesterne i `/admin/integrations` og upload dem i Microsoft 365 Admin Center
  (Integrerede apps). Alle peger på `/office-addin`.

Begge viser appen i en iframe. Brugeren logger ind dér; sessionen er en partitioneret cookie, så den kun
gælder inde i udvidelsen/Office.

## Konfiguration

Alle indstillinger er miljøvariabler — se `.env.example` (lokalt) og `deploy/.env.example` (produktion) og
`server/app/config.py`. Navn, logo, SMS-afsender, GDPR-mail, cookie-tekster og opbevaringsperioder sættes i /admin.
