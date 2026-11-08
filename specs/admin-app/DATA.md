# Handoff: Data i /admin — katalog, udforsk og forbind API

## Overview
En ny sektion **Data** i admin-appen, der samler to ting fra Surdej v1 i én: datakataloget
(`modules/member-data-catalog`) og data-exploreren (`/rental-data/explore`). Kataloget er kortet, Udforsk er
linsen: hvert datasæt i kataloget peger på en tabel eller et API-endpoint, og Udforsk viser rækkerne med
katalogets danske navne, beskrivelser, klassifikation og maskering.

En datakilde kan være containerens egen Postgres eller **et hvilket som helst API**, beskrevet i en
kildebeskrivelse (YAML). Datasæt, der markeres til MCP, bliver læseværktøjer på endpointet `/mcp/data`
(se [`specs/mcp/APP.md`](../mcp/APP.md)).

Design: [`design/data-mcp/`](design/data-mcp/README.md). Høj detaljegrad for layout og tekster; tal og
rækker er eksempeldata.

## Menu
Ny gruppe **Data** i `web/src/admin-app/nav.ts` mellem Produkt og Integrationer:

| Sti | Label | Ikon (lucide) |
| --- | --- | --- |
| `/data` | Katalog | `BookOpen` |
| `/data/explore` | Udforsk | `Table` |
| `/data/sources` | Forbindelser | `Plug` |

Under Integrationer erstattes "MCP-servere" af **MCP-app ↗**, der åbner den separate app på `/mcp`.

Sidemenuen (`AdminShell.tsx`) får desuden, jf. `AdminNav.dc.html`:
- **Søgefelt** "Søg kommando" med ⌘K. Filtrerer menupunkterne på label, sti og gruppenavn; tomme grupper
  skjules, antal træf vises ved gruppen, og "Ingen kommandoer matcher …" når intet passer.
- **Sticky gruppeoverskrifter**. Panelet er altid 100 % højde (`position: sticky; height: 100vh`); kun
  listen scroller. Logo og søgefelt ligger fast øverst, serverfeltet fast nederst. Under 900 px lægger panelet
  sig over indholdet uden intern scroll (som `.tg-side` i dag).
- **Serverfelt**: status, CPU sidste time (sparkline) og bjælker for CPU, hukommelse, disk og
  DB-forbindelser med brugt mod kapacitet. Grøn < 60 %, gul < 85 %, rød derover. Kræver et nyt endpoint
  `GET /api/admin/system` (`require_admin`); `/health` giver i dag kun database-tjek og version.
- **Klap sammen**: klik på logoet klapper panelet sammen til en 56 px strimmel med en burger; burgeren
  folder det ud igen. Valget huskes pr. browser (`localStorage`).

## Skærme

### Katalog — `/admin/data`
- Nøgletal: datasæt, andel beskrevne felter, datasæt udstillet via MCP, afmaskeringer de sidste 30 dage
  (link til audit-loggen).
- Venstre: datakilder (Gær egen database, API-kilder, Object Storage) med antal datasæt og
  "+ Forbind API eller database".
- Højre: datasæt med søgning (navn, felter, beskrivelser), filter på klassifikation og "Kun MCP".
  Kolonner: datasæt (+ tabel/endpoint), datakilde, klassifikation, felter, rækker, MCP, "Udforsk →".

### Datasæt — `/admin/data/:datasæt`
Fanerne fra datakataloget: Beskrivelse, Felter, **Udforsk**, MCP-eksponering, Versioner, Adgang, Feedback.
Mærker i toppen: klassifikation, "Persondata · GDPR-eksport og sletning" når datasættet indeholder
persondata, MCP-endpoint og publiceret version.

Udforsk-fanen: visninger, filter-chips, kolonnevælger, tabel med katalogets kolonnenavne, paginering.
Til højre: den valgte kolonnes metadata fra kataloget, boks for maskerede kolonner med afmaskering, og
"Samme forespørgsel via MCP" (`dataset_query(...)`).

### Udforsk — `/admin/data/explore`
Tabeller og endpoints grupperet efter datakilde, med "Forbind API" øverst og en gruppe "Ikke i kataloget".
Tilstande: Tabel, Rå svar (JSON) for API-kilder (SQL kun læs for Postgres), Diagram. Filtereditor
(felt, operator, værdi; operatorer som i Surdej's `FilterEditor`), "+ Relateret kolonne", gem som visning.
For API-kilder viser hvert filter, om det sendes som API-parameter eller filtreres i Gær efter hentning.
Rækkepanel med felter, relaterede datasæt og link til rå svar.

### Forbind API — `/admin/data/explore/connect`
Trin: Vælg type → Beskriv → Test → Katalogisér. Start fra REST/JSON, OpenAPI (importér spec fra URL),
GraphQL (introspektion), MCP-server (værktøjer bliver datasæt) eller PostgreSQL (læse-forbindelse).
Editor til kildebeskrivelsen, "Hent fra OpenAPI-URL", "Lad AI foreslå felter" (skjules når AI er slået fra),
"Test kald", "Gem som kladde". Højre: datasæt beskrivelsen bliver til, testkald med forhåndsvisning, tjek.

## Kildebeskrivelse (format v1)
```yaml
kilde: dawa
navn: Dataforsyningen · Adresser
type: rest                       # rest | graphql | openapi | mcp | postgres
base_url: https://api.dataforsyningen.dk
auth:
  type: ingen                    # ingen | bearer | header | oauth2
  # hemmelighed: DAWA_TOKEN      # navnet på en miljøvariabel, aldrig selve nøglen
grænser: { kald_pr_minut: 60, timeout_s: 10, cache_min: 60 }

datasæt:
  - id: adresser
    navn: Adresser
    kald: GET /adresser
    parametre:
      q:      { type: tekst, navn: Søg }
      postnr: { type: tal,   navn: Postnr. }
    sider:   { type: side, parameter: side, størrelse: per_side, max: 1000 }
    rækker:  $[*]                # JSONPath til listen i svaret
    nøgle:   id
    felter:
      id:      { type: uuid }
      vej:     { sti: adgangsadresse.vejstykke.navn, navn: Vej }
      postnr:  { sti: adgangsadresse.postnummer.nr,  navn: Postnr. }
      by:      { sti: adgangsadresse.postnummer.navn, navn: By }
    relationer:
      - fra: postnr
        til: postnumre.nr
```

## Regler
- **Kun admin-rollen.** Alle endpoints under `/api/admin/data/...` bruger `require_admin`.
- **Kun læsning af data.** Udforsk og API-kilder læser; der skrives kun til katalogets egne tabeller.
- **Kald går fra serveren.** Browseren kalder aldrig et eksternt API. Værter i en kildebeskrivelse kommer på
  en tilladt-liste, når beskrivelsen gemmes; kald har timeout, grænse pr. minut og cache.
- **Ingen hemmeligheder i beskrivelsen.** `auth.hemmelighed` er navnet på en miljøvariabel, læst via
  `server/app/config.py`. Gemmes en beskrivelse med noget, der ligner en nøgle, afvises den.
- **Klassifikation** Hvid/Grøn/Gul/Rød pr. felt og datasæt (som i datakataloget). Gule og røde felter vises
  maskeret. Afmaskering kræver en årsag, gælder i 15 minutter og skrives i audit-loggen. Tabeller, der ikke er
  i kataloget, kan udforskes, men gule og røde kolonner skjules, til de er katalogiseret.
- **Audit**: oprettelse og ændring af datakilder, datasæt, felter, versioner og afmaskering skrives i
  audit-loggen i samme transaktion (skill `gaer-audit`).
- **GDPR**: datasæt med persondata markeres; eksport og sletning sker stadig i `server/app/gdpr.py`.
  Kataloget ændrer ikke, hvad der er persondata.
- **Migrationer** er nye filer. Forslag til tabeller: `data_sources`, `datasets`, `dataset_fields`,
  `dataset_versions`, `dataset_views`, `dataset_feedback`, `data_unmask_grants`.

## Åbne spørgsmål
- Skal kildebeskrivelser ligge i databasen (redigeres i admin) eller som filer i repoet (`kilder/*.yaml`) eller begge?
- Hvilke kilder skal med fra start: kun egen Postgres + REST, eller også GraphQL, OpenAPI og MCP?
- Skal API-svar caches i Postgres eller kun i hukommelsen?
