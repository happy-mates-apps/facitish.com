# Handoff: /mcp som separat app, der udstiller endpoints

## Overview
MCP-hubben flytter fra `/admin/mcp` til sin egen app på **`/mcp`**, ligesom `/admin` er en separat app.
Appen er stedet, hvor man ser, udstiller og overvåger alle MCP-endpoints i instansen. Hvert endpoint har
sin egen adresse under `/mcp/<navn>`, sin egen adgang og sine egne værktøjer, og alle bruger den almindelige
Gær-login. Ruterne ligger på Python-serveren, så endpoints kan forbindes direkte fra fx Claude.

Design: [`specs/admin-app/design/data-mcp/`](../admin-app/design/data-mcp/README.md) (`Mcp*.dc.html`).
Denne fil supplerer [`README.md`](README.md) og [`SPEC.md`](SPEC.md); værktøjer, kladder og OAuth er uændrede.

## Placering
- Egen Vite-indgang `web/mcp.html` og kode i `web/src/mcp-app/`. Den deler kun `api.ts`, `auth.tsx` og
  `bridge/` med de andre apps; `appBoundary()` i `web/vite.config.ts` udvides til tre apps.
- Kun admin-rollen kan åbne appen (som `/admin`). `/admin` får "MCP-app ↗" i menuen.

## Ruter: én adresse, to svar
| Anmodning | Svar |
| --- | --- |
| Browser: `GET /mcp/<navn>` med `Accept: text/html` | MCP-appens side for endpointet (SPA-fallback i `main.py`) |
| MCP-klient: `POST /mcp/<navn>` (JSON-RPC, Streamable HTTP) eller `GET` med `Accept: text/event-stream` | Selve endpointet |
| Browser: `GET /mcp` | Appens forside (alle endpoints) |
| MCP-klient: `/mcp` | Sendes til `/mcp/app`, så eksisterende forbindelser virker |

Alle endpoints ligger under `/mcp/<navn>`. **Ændring i forhold til README/SPEC:** appens endpoint flytter fra
`/mcp` til `/mcp/app`; `/mcp` virker fortsat for MCP-klienter. OAuth-metadata
(`/.well-known/oauth-protected-resource/mcp/<navn>`) udgives pr. endpoint.

Faner på en endpoint-side er query-parametre: `?fane=vaerktoejer`, `?fane=monitor`, `?fane=forbind`.

## Endpoints
| Type | Eksempel | Hvad |
| --- | --- | --- |
| Indbygget | `/mcp/app`, `/mcp/admin` | De to servere fra `catalog.json` |
| Fra kataloget | `/mcp/data` | Læseværktøjer pr. datasæt markeret til MCP i datakataloget; maskering følger kataloget (se `specs/admin-app/DATA.md`) |
| API-kilde | `/mcp/x/dawa` | Værktøjer ud fra en kildebeskrivelse |
| Ekstern MCP | `/mcp/x/github` | Videresender til en ekstern MCP-server gennem Gær-login; nøgle fra en miljøvariabel |

## Skærme
- **Endpoints (`/mcp`)**: nøgletal (endpoints, afventende kladder, forbundne klienter, kald 24 t) og en tabel
  med endpoint, kilde, hvem må, værktøjer, skrivninger, status. Boksen "Én adresse, to svar" forklarer ruterne.
- **Udstil endpoint**: 1 Kilde (datasæt fra kataloget, API-kilde, ekstern MCP-server, saml værktøjer),
  2 Datasæt og værktøjer (genereres fra katalogets felter), 3 Adgang (alle brugere med fuld session eller kun
  admin, feature-ring, grænse pr. bruger), 4 Adresse (`/mcp/<sti>`, navn i klienten). Højre: `tools/list` som
  forhåndsvisning, tjek, forbind-URL.
- **Endpoint-sider**: Oversigt, Værktøjer, Kladder og monitor, Forbind, som hubben i README.md, med
  serverskifteren Appen `/mcp/app` · Admin `/mcp/admin`.
- **Sidemenu**: endpoints med statusprik, "På tværs" (kladder, monitor, klienter), "Kommandoer", søgefelt,
  sticky overskrifter, serverfelt (MCP-kald pr. minut, CPU, hukommelse, MCP-sessioner, DB-forbindelser) og
  klap sammen til burger, som admin-menuen.

## Regler
- Et nyt eller ændret endpoint udgives som **kladde** og skrives i audit-loggen ved bekræftelse.
- Gule og røde datasæt kan ikke udstilles for "alle brugere", kun for admin-rollen.
- Et endpoint for alle brugere kan styres af en feature-ring (`features`), så det kan rulles ud gradvist.
- Grænser pr. bruger og pr. endpoint; kald logges som i monitoren.
- Ingen nøgler i databasen eller repoet: eksterne servere og API'er bruger navne på miljøvariabler.

## Åbne spørgsmål
- Skal almindelige brugere kunne se `/mcp` (fx deres egne forbindelser), eller kun admin?
- Skal flytningen af appens endpoint til `/mcp/app` ske nu, eller beholdes `/mcp` som kanonisk adresse?
