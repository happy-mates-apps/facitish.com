"""One primary address per instance. Custom domains that are aliases (an apex like smeden.dk, www.smeden.dk, the
instance's own gaer-0000N.toergaer.app once a customer domain is primary) answer with a redirect to ORIGIN, so
passkeys (RP_ID), cookies and links stay on one domain.

    REDIRECT_HOSTS=smeden.dk,www.smeden.dk,gaer-00001.toergaer.app

Set by the Gær Fleet console in the APP_ENV secret (deploy/k8s/CUSTOM-DOMAINS.md); works the same with compose.
/health always answers on every host, so probes and the deploy smoke test are not redirected.
"""

from app import config


def _host(scope) -> str:
    for key, value in scope.get("headers", ()):
        if key == b"host":
            return value.decode("latin-1").rsplit(":", 1)[0].strip().lower().rstrip(".")
    return ""


class CanonicalHostMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        hosts = config.settings.redirect_hosts
        if scope["type"] != "http" or not hosts or scope.get("path") == "/health" or _host(scope) not in hosts:
            return await self.app(scope, receive, send)
        target = config.settings.origin.rstrip("/") + (scope.get("path") or "/")
        if query := scope.get("query_string", b""):
            target += "?" + query.decode("latin-1")
        # 301 for reads (cached, good for search engines); 308 keeps the method and body of anything else.
        status = 301 if scope.get("method") in ("GET", "HEAD") else 308
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"location", target.encode("latin-1")), (b"content-length", b"0"),
                                (b"cache-control", b"public, max-age=3600")]})
        await send({"type": "http.response.body", "body": b""})
