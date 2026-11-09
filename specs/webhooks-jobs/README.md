# Robottjek, baggrundsjobs, oprydning og webhooks (udgående og indgående)

## Robottjek (captcha) ved oprettelse og login med kode
- `GET /api/auth/captcha` giver en proof-of-work-opgave (samme skema som ALTCHA): salt, `sha256(salt + n)`,
  `maxnumber` og en HMAC-signatur. Browseren prøver tal, til hashen passer (`web/src/captcha.ts`).
- `POST /api/auth/otp/start` kræver `captcha` (base64-løsningen). Den bruges både til at oprette en konto og logge
  ind med engangskode. En løsning virker én gang (`captcha_spent`) og udløber efter `CAPTCHA_TTL_SECONDS`.
- Login-siden løser opgaven i baggrunden, mens man skriver sin e-mail, så det ikke føles langsommere.
- Ingen tredjepart, ingen cookies, intet om personen gemmes. Afvisninger logges i auth-loggen som
  `otp.sent` fejl med `reason=captcha`.
- `CAPTCHA=off` slår det fra (testene gør det); i produktion skrives en advarsel i loggen.
  `CAPTCHA_MAX_NUMBER` (50 000) styrer arbejdet: ca. halvt så mange SHA-256 i browseren.

## Baggrundsjobs (`server/app/jobs.py`)
- Køen er tabellen `jobs` i Postgres. Workers i app-processen (`JOB_WORKERS`, standard 2) tager næste job med
  `for update skip locked`, så flere containere kan køre samtidig uden at tage det samme job.
- `await jobs.enqueue(conn, "kind", payload, dedupe_key=…)` i samme transaktion som ændringen.
  `@jobs.handler("kind")` registrerer koden. Returværdien gemmes som resultat.
- Fejl prøves igen med 30 s, 1 min, 2 min … (højst 1 time) op til `max_attempts`, derefter `dead`
  (og hændelsen `job.dead` sendes til webhooks). Et job, der hænger længere end `JOB_TIMEOUT_SECONDS`, sættes tilbage.
- `job_schedules` er gentagne jobs: `maintenance` (hver time), `retention.logs` (dagligt, purge-brugeren),
  `retention.cleanup` (hver time). /admin/jobs kan pause, ændre interval og køre nu.
- `RUN_MAINTENANCE=0` stopper workers og scheduler (testene driver køen med `jobs.run_pending()`).

## Oprydning (`retention_policies`)
| Nøgle | Hvad | Standard |
| --- | --- | --- |
| `jobs` | afsluttede jobs | 30 dage |
| `webhook_deliveries` | leverede og opgivne leveringer | 30 dage |
| `otp_codes` | engangskoder (hash) | 1 dag |
| `webauthn_challenges` | udløbne passkey-udfordringer | 1 dag |
| `sessions` | udløbne sessioner | 30 dage |
| `captcha_spent` | brugte captchaer | 1 dag |
| `review_orphans` | tomme, afsluttede review-sessioner | 90 dage |

SQL'en ligger i `retention.CLEANUP_SQL`; tabellen har kun periode og til/fra. Hver kørsel skriver
`retention.cleanup` med antal i audit-loggen. Loggene (auth, audit, analytics, MCP) har stadig deres egne perioder
i /admin/retention og slettes af purge-brugeren.

## Webhooks (`server/app/webhooks.py`, /admin/webhooks)
- `await webhooks.emit(conn, "event", data)` i samme transaktion som ændringen → én levering pr. abonnerende
  endpoint og ét job `webhook.deliver`.
- POST med JSON `{"id", "event", "created_at", "data"}` og headerne `X-Gaer-Event`, `X-Gaer-Delivery` (samme ved
  gentagelser: brug den til at undgå dobbeltbehandling), `X-Gaer-Timestamp`, `X-Gaer-Attempt` og
  `X-Gaer-Signature: t=<tid>,v1=<hex HMAC-SHA256(secret, "<tid>.<body>")>`.
- **Auth-header er valgfri**: navn (standard `Authorization`) og værdi pr. endpoint, fx `Bearer …`. Værdien og
  signeringsnøglen krypteres med AES-GCM (`SECRET_BOX_KEYS`, ellers afledt af `SECRET_KEY`), vises aldrig igen
  (kun sidste fire tegn) og skrives aldrig i audit-loggen. Signeringsnøglen vises én gang og kan roteres.
- Alt andet end 2xx prøves igen med backoff op til `max_attempts`. 410 Gone eller 10 opgivne leveringer i træk
  slår endpointet fra (`webhook.disabled` i audit-loggen). Redirects følges ikke.
- Kun https til offentlige adresser; adressen slås op igen før hver levering (mod DNS-rebinding).
  `WEBHOOK_ALLOW_PRIVATE=1` tillader http og localhost under udvikling.
- Oprettelse, ændring og ny nøgle kræver en frisk anden faktor (step-up). Test-knappen sender `webhook.ping`
  med det samme; »Send igen« sender den samme levering (samme id) igen.
- Hændelser: `webhook.ping`, `user.created`, `user.deleted`, `gdpr.request.created`, `review.feedback.created`,
  `review.session.ended`, `job.dead`. De bærer id'er og stier, ikke persondata.

## Indgående webhooks (`server/app/webhooks_in.py`, /admin/webhooks → Indgående)
Andre systemer sender `POST /api/hooks/in/<nøgle>`. Nøglen i URL'en er tilfældig og kan skiftes. Hvert endpoint
vælger, hvordan afsenderen beviser, hvem den er:

| Bekræftelse | Afsenderen sender | Til |
| --- | --- | --- |
| `gaer` | `X-Gaer-Signature: t=…,v1=…` (tidsstempel inden for `tolerance_seconds`) | en anden Gær-instans |
| `hmac` | `<header>: sha256=<hex>`, `<hex>` eller base64 af HMAC-SHA256(nøgle, body) | GitHub, Shopify m.fl. |
| `token` | `<header>: <fast værdi>`, fx `Authorization: Bearer …` | systemer med et auth-header |
| `none` | intet; kun den hemmelige URL | simple formularer, helst med IP-filter |

- Nøglen eller tokenet kan være afsenderens egen (indtastes) eller laves af os (vises én gang). Den gemmes krypteret.
- Valgfrit: tilladte IP-intervaller, maks. størrelse (standard 256 KB), maks. pr. minut (standard 120).
- Hændelsens navn fra et header (fx `X-GitHub-Event`) eller et JSON-felt (`type`, `data.event`); leverings-id fra
  et header (fx `X-GitHub-Delivery`, `Idempotency-Key`) — samme id gemmes kun én gang og svares 200 `duplicate`.
- Svar: 202 `{"id"}` ved modtagelse; 401 forkert/manglende bevis, 403 IP, 413 for stor, 429 for mange, 404 ukendt
  eller slået fra. Afviste kald gemmes ikke, de tælles på endpointet med grund og tid.
- Gemte hændelser (`webhook_inbound`) har headers uden hemmeligheder (Authorization, cookies, signaturer fjernes)
  og body. Jobbet `webhook.inbound` kører endpointets handler med retries; »Kør igen« i admin kører den igen.
- Handlers skrives i koden, så hvad en webhook må gøre, bliver reviewet:

```python
from app import webhooks_in

@webhooks_in.handler("betaling", "Markerer ordren som betalt")
async def paid(event: dict, endpoint: dict) -> dict:
    data = event["body_json"]          # også event["headers"], event["event"], event["external_id"]
    ...                                # skriv i databasen med audit i samme transaktion
    return {"order": data["id"]}
```

- Opbevaring: `webhook_inbound` i `retention_policies` (30 dage). Indholdet kan rumme persondata fra afsenderen —
  hold perioden kort.

Modtagerens tjek af vores udgående webhooks (Python):

```python
import hmac, hashlib, time
def ok(secret: str, header: str, body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    ts = int(parts["t"])
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return abs(time.time() - ts) < 300 and hmac.compare_digest(mac, parts["v1"])
```
