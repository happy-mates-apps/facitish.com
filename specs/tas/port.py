"""Ports the TAS artifact's published files into server/app/web_static/tas/.

    python specs/tas/port.py <folder with the artifact's index.html, app.js, engine.js …>

The artifact ran on claude.ai with `window.claude` (db, user, sample, assets). In Gær the same calls are answered
by web_static/tas/gaer.js on top of /api/tas, so the simulator's own code stays as it was apart from the small,
named patches below. Every patch must apply exactly once; the script stops if one no longer matches, so a new
version of the artifact is never half-ported.
"""

import hashlib
import re
import sys
from pathlib import Path

DEST = Path(__file__).resolve().parents[2] / "server" / "app" / "web_static" / "tas"
SCRIPTS = ["soon.js", "models.js", "lane3600.js", "engine.js", "assistant.js", "app.js"]


def sub_once(text: str, old: str, new: str, name: str, count: int = 1) -> str:
    n = text.count(old)
    if n != count:
        sys.exit(f"patch '{name}': expected {count} match(es), found {n}")
    return text.replace(old, new)


APP_PATCHES = [
    # Images are served by Gær, not the artifact's blob store.
    ("blob urls", "'/_blob/'", "'/api/tas/assets/'", 3),
    # The Admin Portal opens for editors (admin role Fuld adgang or Indhold, with a second factor), not a shared password.
    ("unlock",
     "try { unlocked = sessionStorage.getItem('fc233-admin') === PASS_HASH; } catch (e) {}",
     "unlocked = !!(window.TAS_ENV && window.TAS_ENV.canEdit);", 1),
    ("lock screen",
     "    VIEWS.admin.classList.add('locked');\n    body.innerHTML = lockHtml(err);",
     "    VIEWS.admin.classList.add('locked');\n    if (window.TAS_ENV) { body.innerHTML = window.TAS_ENV.lockHtml(); return; }\n    body.innerHTML = lockHtml(err);", 1),
    ("gate text",
     "The Admin Portal is only available when you’re signed in to Claude. Sign in on claude.ai, then reopen this page.",
     "The Admin Portal can’t reach the knowledge store right now. Reload the page to try again.", 1),
    # There is no separate public copy: everyone reads the live published release from /api/tas.
    ("public copy", "const stale = pub && (!pc ||", "const stale = !window.TAS_ENV && pub && (!pc ||", 1),
    ("portal button", "$('#tabPortal').hidden = S.view === 'admin';",
     "$('#tabPortal').hidden = S.view === 'admin' || !(window.TAS_ENV && window.TAS_ENV.canEdit);", 1),
    ("upload text", "only available to people who can edit this artifact", "only available to editors", 4),
]


def port(src: Path) -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    app = (src / "app.js").read_text(encoding="utf-8")
    for name, old, new, count in APP_PATCHES:
        app = sub_once(app, old, new, name, count)
    files = {name: (src / name).read_text(encoding="utf-8") for name in SCRIPTS if name != "app.js"}
    files["app.js"] = app

    html = (src / "index.html").read_text(encoding="utf-8")
    # Inline scripts are not allowed by the CSP (script-src 'self'): the logo moves to its own file.
    mark = re.search(r'<script>(window\.TAS_MARK=.*?)</script>', html, re.S)
    if not mark:
        sys.exit("patch 'mark': no inline TAS_MARK script")
    files["mark.js"] = mark.group(1) + "\n"
    html = html.replace(mark.group(0), "")
    if re.search(r"<script>(?!</script>)", html):
        sys.exit("an inline script is left in index.html")
    html = sub_once(html, '<meta name="claude:viewport-fit-sides" content="cover">\n', "", "claude meta")
    html = sub_once(html, '<script src="public.js"></script>\n', "", "public copy")
    html = sub_once(html, "<!doctype html><html>", '<!doctype html><html lang="en">', "lang")
    # Gær's own button in the TAS header: log in (on /w) or open the backoffice (signed in); gaer.js fills it in.
    html = sub_once(html, '<button type="button" class="btn" data-view="admin" id="tabPortal">',
                    '<a class="btn" id="gaerLink" href="/login?next=/backoffice" hidden></a>\n'
                    '    <button type="button" class="btn" data-view="admin" id="tabPortal">', "gaer link")

    digest = hashlib.sha256("".join(files[k] for k in sorted(files)).encode()).hexdigest()[:10]
    tags = ['<script src="/w/tas/env.js?mode=__MODE__"></script>', f'<script src="/w/tas/gaer.js?v={digest}"></script>',
            f'<script src="/w/tas/mark.js?v={digest}"></script>']
    for name in SCRIPTS:
        html = sub_once(html, f'<script src="{name}"></script>', "", f"script {name}")
        tags.append(f'<script src="/w/tas/{name}?v={digest}"></script>')
    html = re.sub(r"\n{3,}", "\n\n", html)
    html = html.replace("</body>", "\n".join(tags) + "\n</body>", 1) if "</body>" in html else html + "\n".join(tags) + "\n"

    for name, text in files.items():
        (DEST / name).write_text(text, encoding="utf-8")
    (DEST / "index.html").write_text(html, encoding="utf-8")
    print(f"ported into {DEST} (v={digest})")


if __name__ == "__main__":
    port(Path(sys.argv[1]))
