"""Incoming webhooks: POST /api/hooks/in/<key> from other systems.

Each endpoint (webhook_endpoints, set up in /admin/webhooks → Indgående) decides how a request is verified:

    gaer   X-Gaer-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>   (what our own webhooks send;
           the timestamp must be within tolerance_seconds, so a captured request cannot be replayed later)
    hmac   <header_name>: sha256=<hex> | <hex> | <base64> of HMAC-SHA256(secret, body)   (GitHub, Shopify, …)
    token  <header_name>: <exact value>, e.g. Authorization: Bearer …                     (with an auth header)
    none   only the secret URL                                                            (without an auth header)

On top of that: an optional list of allowed IP ranges, a body size limit and a limit per minute. A request that
fails is answered 401/403/413/429 and only counted on the endpoint (reason and time); its body is not stored.

An accepted request is stored in webhook_inbound (headers without secrets) and answered 202 at once. The job
webhook.inbound then runs the endpoint's handler, with retries and backoff from app.jobs. The same sender delivery id
(id_header, or X-Gaer-Delivery) is stored once: a repeat is answered 200 {"duplicate": true}.

Handlers live in the code, so what a webhook may do is reviewed like any other change:

    @webhooks_in.handler("github-push", "Opretter et klip pr. push")
    async def on_push(event: dict, endpoint: dict) -> dict | None: ...

Inbound bodies can contain personal data from the sending system: keep the retention period short
(retention_policies 'webhook_inbound', default 30 days).
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app import db, jobs, secrets_box, webhooks
from app.logs import RequestMeta, audit

Handler = Callable[[dict, dict], Awaitable[dict | None]]


@dataclass(frozen=True)
class HandlerInfo:
    fn: Handler
    description: str


HANDLERS: dict[str, HandlerInfo] = {}

# Never stored with an event, whatever the endpoint's settings.
SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie", "x-gaer-signature", "x-hub-signature",
                  "x-hub-signature-256", "x-shopify-hmac-sha256", "stripe-signature", "x-signature"}


class Rejected(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def handler(name: str, description: str):
    def register(fn: Handler) -> Handler:
        HANDLERS[name] = HandlerInfo(fn, description)
        return fn
    return register


def new_key() -> str:
    return "in_" + uuid.uuid4().hex + uuid.uuid4().hex[:8]


# ── Verification ────────────────────────────────────────────────────────────

def _secret(endpoint: dict) -> str:
    if not endpoint["secret_enc"]:
        raise Rejected(401, "no_secret")
    return secrets_box.decrypt(endpoint["secret_enc"], "webhook-in")


def verify(endpoint: dict, headers: dict[str, str], body: bytes) -> None:
    """Raises Rejected unless the request proves it comes from the sender. headers: lower-case names."""
    mode = endpoint["verify"]
    if mode == "none":
        return
    if mode == "gaer":
        value = headers.get("x-gaer-signature")
        if not value:
            raise Rejected(401, "missing_signature")
        if not webhooks.verify_signature(_secret(endpoint), value, body, tolerance=endpoint["tolerance_seconds"]):
            raise Rejected(401, "bad_signature")
        return
    name = (endpoint["header_name"] or ("Authorization" if mode == "token" else "X-Signature-256")).lower()
    value = (headers.get(name) or "").strip()
    if not value:
        raise Rejected(401, "missing_header")
    secret = _secret(endpoint)
    if mode == "token":
        if not hmac.compare_digest(value.encode(), secret.encode()):
            raise Rejected(401, "bad_token")
        return
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    given = value.split("=", 1)[1] if value.lower().startswith("sha256=") else value
    if not (hmac.compare_digest(given.lower(), digest.hex()) or hmac.compare_digest(given, base64.b64encode(digest).decode())):
        raise Rejected(401, "bad_signature")


def ip_allowed(endpoint: dict, ip: str | None) -> bool:
    nets = endpoint["allowed_ips"] or []
    if not nets:
        return True
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in ipaddress.ip_network(str(n), strict=False) for n in nets)


def _field(data, path: str):
    for part in path.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data if isinstance(data, (str, int, float)) else None


def stored_headers(endpoint: dict, headers: dict[str, str]) -> dict[str, str]:
    drop = SECRET_HEADERS | ({endpoint["header_name"].lower()} if endpoint["header_name"] else set())
    return {k: v[:500] for k, v in headers.items() if k not in drop}


# ── Receiving ───────────────────────────────────────────────────────────────

async def reject(endpoint_id: int, reason: str) -> None:
    async with db.connection() as conn:
        await conn.execute("""update webhook_endpoints set rejected_count = rejected_count + 1, last_rejected_at = now(),
                                     last_rejected_reason = %s where id = %s""", (reason, endpoint_id))


async def receive(endpoint: dict, headers: dict[str, str], body: bytes, ip: str | None) -> dict:
    """Checks and stores one request. Raises Rejected. Returns {"id", "duplicate"}."""
    if not endpoint["active"]:
        raise Rejected(404, "inactive")
    if not ip_allowed(endpoint, ip):
        raise Rejected(403, "ip_not_allowed")
    if len(body) > endpoint["max_body_kb"] * 1024:
        raise Rejected(413, "too_large")
    verify(endpoint, headers, body)

    text = body.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text) if text.strip() else None
    except ValueError:
        parsed = None
    event = None
    if endpoint["event_header"]:
        event = headers.get(endpoint["event_header"].lower())
    if event is None and endpoint["event_field"] and parsed is not None:
        event = _field(parsed, endpoint["event_field"])
    if event is None and endpoint["verify"] == "gaer":
        event = headers.get("x-gaer-event")
    external_id = headers.get(endpoint["id_header"].lower()) if endpoint["id_header"] else None
    if external_id is None and endpoint["verify"] == "gaer":
        external_id = headers.get("x-gaer-delivery")

    event_id = uuid.uuid4()
    async with db.connection() as conn:
        recent = await db.fetch_one(conn, """select count(*) as n from webhook_inbound
                                             where endpoint_id = %s and received_at > now() - interval '1 minute'""",
                                    (endpoint["id"],))
        if recent["n"] >= endpoint["max_per_minute"]:
            raise Rejected(429, "rate_limited")
        row = await db.fetch_one(conn, """
            insert into webhook_inbound (id, endpoint_id, external_id, event, content_type, headers, body, body_json, ip)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (endpoint_id, external_id) where external_id is not null do nothing returning id""",
            (event_id, endpoint["id"], (external_id or None) and str(external_id)[:200],
             (event or None) and str(event)[:200], (headers.get("content-type") or "")[:200],
             json.dumps(stored_headers(endpoint, headers)), text,
             json.dumps(parsed) if parsed is not None else None, ip))
        if row is None:
            existing = await db.fetch_one(conn, "select id from webhook_inbound where endpoint_id = %s and external_id = %s",
                                          (endpoint["id"], str(external_id)[:200]))
            return {"id": existing["id"] if existing else None, "duplicate": True}
        await conn.execute("""update webhook_endpoints set received_count = received_count + 1, last_received_at = now()
                              where id = %s""", (endpoint["id"],))
        await jobs.enqueue(conn, "webhook.inbound", {"id": str(event_id)}, max_attempts=5,
                           dedupe_key=f"inbound:{event_id}")
        await audit(conn, "webhook.received", actor_id=None, meta=RequestMeta(ip=ip), table="webhook_inbound",
                    row_id=event_id, endpoint_id=endpoint["id"], event=event, bytes=len(body))
    return {"id": event_id, "duplicate": False}


# ── Processing (job) ────────────────────────────────────────────────────────

@jobs.handler("webhook.inbound")
async def process(payload: dict, job: dict) -> dict | None:
    async with db.connection() as conn:
        event = await db.fetch_one(conn, "select * from webhook_inbound where id = %s", (payload["id"],))
        if event is None:
            return {"missing": True}
        endpoint = await db.fetch_one(conn, "select * from webhook_endpoints where id = %s", (event["endpoint_id"],))
        await conn.execute("update webhook_inbound set attempts = attempts + 1 where id = %s", (event["id"],))
    info = HANDLERS.get(endpoint["handler"])
    if info is None:
        async with db.connection() as conn:
            await conn.execute("""update webhook_inbound set status = 'ignored', error = %s, processed_at = now()
                                  where id = %s""", (f"Ingen handler '{endpoint['handler']}' i koden", event["id"]))
        return {"ignored": True}
    try:
        result = await info.fn(event, endpoint)
    except Exception as e:
        async with db.connection() as conn:
            await conn.execute("update webhook_inbound set error = %s where id = %s", (str(e)[:2000], event["id"]))
        raise
    async with db.connection() as conn:
        await conn.execute("""update webhook_inbound set status = 'processed', result = %s, error = null,
                                     processed_at = now() where id = %s""",
                           (json.dumps(result, default=str) if result is not None else None, event["id"]))
    return result


async def _inbound_dead(conn, job: dict, error: str) -> None:
    await conn.execute("update webhook_inbound set status = 'failed', processed_at = now() where id = %s",
                       (job["payload"]["id"],))
    await webhooks.emit(conn, "job.dead", {"job_id": job["id"], "kind": job["kind"], "error": error[:300]})


jobs.DEAD_HOOKS["webhook.inbound"] = _inbound_dead


# ── Built-in handlers ───────────────────────────────────────────────────────

@handler("store", "Gem kun hændelsen, så den kan ses i /admin og hentes via API")
async def store(event: dict, endpoint: dict) -> dict:
    return {"stored": True}
