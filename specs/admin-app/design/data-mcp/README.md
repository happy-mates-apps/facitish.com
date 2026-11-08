# Design: Data i /admin og MCP-appen på /mcp

Designreferencer lavet i HTML (Design Components), med mock-data. Det er ikke produktionskode. Specs og
regler står i [`specs/admin-app/DATA.md`](../../DATA.md) og [`specs/mcp/APP.md`](../../../mcp/APP.md).

Canvas med alle artboards side om side: https://claude.ai/artifact/R95NXUaPsYmj3RwoyRZo7j
(privat; skal deles fra Share-menuen, før andre kan åbne det). Filerne her er en kopi af canvassets indhold.
`canvas.json` er canvassets indeks med placering, titler og noter.

Åbn en `.dc.html` i en browser for at se den. `support.js` er Design Component-runtime (samme fil som i
`../support.js`). Komponenterne `AdminNav` og `McpNav` hentes med `<dc-import>` fra samme mappe.

| Fil | Rute | Hvad |
| --- | --- | --- |
| `AdminNav.dc.html` | – | Admin-sidemenu: Tørgær-mærke, søgefelt (⌘K) der filtrerer kommandoer, sticky områdeoverskrifter, scroll inde i panelet, serverfelt med belastning og kapacitet, klap sammen til burger |
| `Main.dc.html` | `/admin/data` | Katalog: datakilder, datasæt med klassifikation, felter, rækker og MCP-status |
| `DataDataset.dc.html` | `/admin/data/:datasæt` | Datasæt (Klip) med fanen Udforsk: filtre, kolonner med katalogets navne, maskeret Ejer, afmaskering med årsag, samme forespørgsel via MCP |
| `DataExplore.dc.html` | `/admin/data/explore` | Udforsk på tværs af kilder; her et API-datasæt (Dataforsyningen · Adresser), hvor hvert filter viser om det sendes til API'et eller filtreres i Gær |
| `DataConnect.dc.html` | `/admin/data/explore/connect` | Forbind API: start fra REST, OpenAPI, GraphQL, MCP-server eller PostgreSQL; kildebeskrivelse i YAML; testkald og tjek |
| `AdminHeatmaps.dc.html` | `/admin/heatmaps` | Eksisterende side tegnet efter `web/src/admin-app/pages/Heatmaps.tsx` |
| `McpNav.dc.html` | – | MCP-appens sidemenu: endpoints, på tværs, kommandoer, søgefelt, serverfelt, burger |
| `McpHome.dc.html` | `/mcp` | Alle endpoints og "Én adresse, to svar" (browser → appen, MCP-klient → endpointet) |
| `McpExpose.dc.html` | `/mcp?ny=endpoint` | Udstil et endpoint: kilde, datasæt og værktøjer, adgang, sti |
| `McpOverview.dc.html` | `/mcp/app`, `/mcp/admin` | Oversigt for de indbyggede endpoints (serverskifter virker i Play) |
| `McpTools.dc.html` | `/mcp/:endpoint?fane=vaerktoejer` | Værktøjer og inspektør med kladde |
| `McpMonitor.dc.html` | `/mcp/:endpoint?fane=monitor` | Kladder og live kald |
| `McpConnect.dc.html` | `/mcp/:endpoint?fane=forbind` | Claude Code, Claude Desktop og VS Code, forbundne klienter |

Tal i serverfelterne, klikpunkter i heatmaps og rækker i tabellerne er eksempeldata. Felter som
`[ANTAL]` og `[DATAEJER]` er pladsholdere for rigtige værdier.
