"""/w — the public website, server-rendered from Markdown pages edited in /admin/web.

Language: ?lang=da|en (remembered in the w_lang cookie), then the cookie, then Danish.
Anonymous visitors to / are sent here (see main.py). Page views go through the same
self-hosted analytics as the app (static/w.js), with the same consent.
"""

import io
import os
import zipfile
from html import escape

import markdown
import nh3
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

from app import config, db, settings_store

router = APIRouter(tags=["web"])

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web_static")
LANGS = ("da", "en")
TEXT = {
    "da": {"login": "Log ind", "privacy": "Privatliv", "other": "English", "missing": "Siden findes ikke"},
    "en": {"login": "Log in", "privacy": "Privacy", "other": "Dansk", "missing": "Page not found"},
}
ALLOWED_TAGS = {"h1", "h2", "h3", "h4", "p", "a", "ul", "ol", "li", "strong", "em", "code", "pre", "blockquote",
                "img", "hr", "br", "table", "thead", "tbody", "tr", "th", "td"}


def render_markdown(source: str) -> str:
    html = markdown.markdown(source, extensions=["tables", "fenced_code", "sane_lists"])
    return nh3.clean(html, tags=ALLOWED_TAGS, attributes={"a": {"href", "title"}, "img": {"src", "alt", "title"}},
                     url_schemes={"http", "https", "mailto", "tel"})


def _lang(request: Request) -> tuple[str, bool]:
    q = request.query_params.get("lang")
    if q in LANGS:
        return q, True
    c = request.cookies.get("w_lang")
    return (c if c in LANGS else "da"), False


def _page_html(*, lang: str, page: dict | None, nav: list[dict], values: dict, slug: str) -> str:
    t = TEXT[lang]
    other = "en" if lang == "da" else "da"
    name = escape(values["app_name"])
    title = escape(page["title"]) if page else t["missing"]
    description = escape(page["description"]) if page else ""
    base = config.settings.origin.rstrip("/")
    path = f"/w/{slug}" if slug else "/w/"
    logo = '<img src="/api/public/logo" alt="">' if values["logo_key"] else '<span class="dot"></span>'
    links = "".join(
        f'<a href="/w/{escape(p["slug"])}"{" class=active" if p["slug"] == slug else ""}>{escape(p["title"])}</a>'
        for p in nav if p["slug"])
    body = render_markdown(page["body"]) if page else f"<h1>{t['missing']}</h1>"
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · {name}</title>
<meta name="description" content="{description}">
<meta property="og:title" content="{title}"><meta property="og:description" content="{description}">
<meta property="og:site_name" content="{name}"><meta property="og:type" content="website">
<link rel="canonical" href="{base}{path}?lang={lang}">
<link rel="alternate" hreflang="da" href="{base}{path}?lang=da"><link rel="alternate" hreflang="en" href="{base}{path}?lang=en">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/w/static/w.css">
<script src="/w/static/w.js" defer></script>
</head>
<body>
<header class="top"><div class="inner">
  <a class="brand" href="/w/">{logo}{name}</a>
  <nav>{links}<a href="{path}?lang={other}" class="lang">{t['other']}</a><a class="login" href="/login">{t['login']}</a></nav>
</div></header>
<main class="content">{body}</main>
<footer><div class="inner"><span>© {name}</span><a href="/privatliv">{t['privacy']}</a></div></footer>
</body>
</html>"""


@router.get("/w", include_in_schema=False)
async def w_root():
    return RedirectResponse("/w/", status_code=308)


@router.get("/w/static/{name}", include_in_schema=False)
async def w_static(name: str):
    if name not in ("w.css", "w.js"):
        raise HTTPException(404)
    return FileResponse(os.path.join(STATIC_DIR, name), headers={"Cache-Control": "public, max-age=300"})


@router.get("/w/{slug:path}", response_class=HTMLResponse, include_in_schema=False)
async def w_page(slug: str, request: Request):
    slug = slug.strip("/")
    lang, explicit = _lang(request)
    async with db.connection() as conn:
        values = await settings_store.get_all(conn)
        page = await db.fetch_one(conn, "select * from web_pages where slug = %s and lang = %s and published",
                                  (slug, lang))
        nav = await db.fetch_all(conn, """select slug, title from web_pages where lang = %s and published
                                          and nav_order is not null order by nav_order, title""", (lang,))
    html = _page_html(lang=lang, page=page, nav=nav, values=values, slug=slug)
    response = HTMLResponse(html, status_code=200 if page else 404, headers={"Cache-Control": "no-cache"})
    if explicit:
        response.set_cookie("w_lang", lang, max_age=365 * 86400, samesite="lax", secure=config.settings.secure_cookies)
    return response


# ── Browser extension download ─────────────────────────────────────────────

@router.get("/api/extension/download", include_in_schema=False)
async def extension_download():
    """The extension in extension/, zipped with this instance's address as the default endpoint.
    Load it in Chrome/Edge via chrome://extensions → Load unpacked, or publish it to the stores."""
    root = os.path.abspath(config.settings.extension_dir)
    if not os.path.isdir(root):
        raise HTTPException(404, "Udvidelsen er ikke med i dette build")
    async with db.connection() as conn:
        name = await settings_store.get(conn, "app_name")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(root):
            for f in files:
                full = os.path.join(folder, f)
                rel = os.path.relpath(full, root)
                data = open(full, "rb").read()
                if rel in ("manifest.json", "config.js"):
                    data = (data.decode().replace("__GAER_ENDPOINT__", config.settings.origin.rstrip("/"))
                            .replace("__GAER_NAME__", name.replace('"', ""))).encode()
                z.writestr(os.path.join("gaer-extension", rel), data)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="gaer-extension.zip"'})
