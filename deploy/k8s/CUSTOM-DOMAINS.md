# Custom domains for a Gær instance

A fork made by the Gær Fleet console always answers on `gaer-0000N.toergaer.app`. A customer can add their own domain,
for example `smeden.dk`, and map any of these to the instance:

- the apex: `smeden.dk`
- `www.smeden.dk`
- `app.smeden.dk`, or any other subdomain

One of the hostnames can be the **primary**. All the others redirect to it, and so does `gaer-0000N.toergaer.app`.
Everything is done from the fork's page in the console (Surdej → `/admin/gaer-fleet` → Forks → the fork → *Custom domains*).
The console's *DNS guide* page explains the same steps.

## 1. Prove ownership

When a domain is added, the console makes a token. The customer creates this record:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_gaer-verify.smeden.dk` | `gaer-verify=<token>` |

**Check TXT** looks the record up at 1.1.1.1 and 8.8.8.8. No hostname under a domain can be mapped until the token is found.
This stops anyone from pointing a domain they do not own at an instance. A domain belongs to one fork, and domains on
different forks cannot overlap (`smeden.dk` on one fork and `shop.smeden.dk` on another).

## 2. Point the hostnames at the instance

| Hostname | Record |
| --- | --- |
| `app.smeden.dk`, `www.smeden.dk` | `CNAME` → `gaer-0000N.toergaer.app` |
| `smeden.dk` (apex) | `ALIAS` / `ANAME` / flattened `CNAME` → `gaer-0000N.toergaer.app` |

An apex cannot have a CNAME. The customer can solve that in one of these ways:

- **ALIAS, ANAME or flattening.** Use the provider's ALIAS or ANAME record. Cloudflare DNS flattens a CNAME on the apex by itself.
- **A records.** Use these only when Cloudflare apex proxying is set up and its IPs are entered as *Apex IPs* in the console's settings.
- **Forwarding.** Forward the apex to `https://www.smeden.dk` at the registrar, map only `www`, and leave the apex out of the console.
- **Moving DNS.** Move the domain's DNS to Cloudflare, then use the first option.

Each hostname is registered as a **Cloudflare for SaaS custom hostname** on the `toergaer.app` zone. Cloudflare issues
its certificate as soon as the record points at us. To get the certificate before switching an existing site, Cloudflare
can ask for extra TXT records (`_cf-custom-hostname.…`). The console shows them per hostname.

## 3. Apply

**Apply and deploy** does three things:

1. It writes the Ingress `gaer-custom-domains` in the fork's namespace with every mapped hostname. This Ingress sits next to the one
   from `app.yaml`, and the deploy workflow never touches it.
2. It adds these lines to the `APP_ENV` secret. They come after the fork's own lines, so they win.
   - With a custom primary: `DOMAIN`, `ORIGIN` and `RP_ID` are set to the primary.
   - Always: `REDIRECT_HOSTS` lists every other hostname, plus `gaer-0000N.toergaer.app`.
3. It starts `deploy.yml`, so the app picks up the new settings.

The app does the redirect itself (`server/app/canonical_host.py`). A `GET` gets `301` and other methods get `308`, with
the path and query kept. `/health` answers on every host.

## Before you change the primary

- **Passkeys.** `RP_ID` follows the primary. Passkeys registered on another address stop working, and users then log in with a code
  and add a new passkey. Choose the primary before people register.
- **License.** `LICENSE_KEY` must list the primary, or `/w` says the installation is unlicensed.
- **Mail.** `MAIL_FROM` and the domain's SPF/DKIM for Lettermint are separate, and are set up in `/admin/mail`.

## One-time setup on the toergaer.app zone

The console does this from **Clusters → Configure Cloudflare**. The Cloudflare API token needs *SSL and Certificates: Edit*
and *DNS: Edit* on the zone, plus *Cloudflare Tunnel: Edit* on the account. You also need to turn on Cloudflare for SaaS
under SSL/TLS → Custom Hostnames. The button sets up:

- **Tunnel ingress rules.** `*.toergaer.app` goes to the ingress controller, and so does a catch-all rule. Custom hostnames
  arrive with their own `Host` header, so without the catch-all the tunnel answers them with 404.
- **DNS.** `*.toergaer.app` and `fallback.toergaer.app` become proxied CNAMEs to `<tunnel-id>.cfargotunnel.com`.
- **Fallback origin.** The fallback origin for custom hostnames is set to `fallback.toergaer.app`.

## Til kunden (skabelon)

Konsollen laver teksten med de præcise værdier: åbn domænet på forken og vælg *Guide for the customer*. Teksten ser sådan ud:

```
1. Bevis at domænet er jeres
   Type: TXT   Navn: _gaer-verify.smeden.dk   Værdi: gaer-verify=<token>
2. app.smeden.dk (hovedadresse)
   Type: CNAME   Navn: app.smeden.dk   Værdi: gaer-00001.toergaer.app
3. smeden.dk (sender videre til app.smeden.dk)
   ALIAS/ANAME/"CNAME flattening": smeden.dk → gaer-00001.toergaer.app
   eller videresendelse hos udbyderen: smeden.dk → https://www.smeden.dk
Slet gamle A-, AAAA- eller CNAME-poster med samme navn. Bruger I Cloudflare: "DNS only" (grå sky).
```
