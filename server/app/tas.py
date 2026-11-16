"""TAS — Terminal Assistance Simulator (spec: specs/tas/README.md).

A virtual payment terminal with a chat assistant (TAS) for customer service agents, ported from a claude.ai
artifact. The simulator itself is plain JavaScript in web_static/tas/ and keeps its data as documents in named
collections; this module stores them in Postgres (tas_docs, tas_assets) and decides who may read and write what.

- Published collections (the live menu, knowledge, accessories, translations, TAS settings) are public: /w/ shows
  the simulator to everyone, as the artifact did.
- Drafts and release history are for editors: admins with the admin role Fuld adgang or Indhold and a second factor
  within ADMIN_MFA_HOURS, the same rule as /admin. They edit in the Admin Portal at /backoffice.
- On a new instance the tables are filled once from tas_seed/ (the artifact's database and images, 11 Nov 2026).
"""

import gzip
import json
import re
from pathlib import Path

import httpx
from psycopg.types.json import Jsonb

from app import admin_roles, config, db
from app.sessions import Principal, admin_mfa_ok

PUBLIC_COLLECTIONS = frozenset({"models", "published", "pubpart", "pubacc", "tas", "i18n"})
EDITOR_COLLECTIONS = frozenset({"nodes", "articles", "troubles", "kb", "accessories", "releases", "accrel", "notes"})
COLLECTIONS = PUBLIC_COLLECTIONS | EDITOR_COLLECTIONS
EDITOR_ROLES = frozenset({admin_roles.FULL, "indhold"})

DOC_ID = re.compile(r"^[A-Za-z0-9_.:@+~-]{1,200}$")
MAX_DOC_BYTES = 2 * 1024 * 1024          # a release keeps its articles in parts; the largest is ~260 kB
MAX_ASSET_BYTES = 5 * 1024 * 1024        # the Admin Portal refuses larger images itself
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}

SEED_DIR = Path(__file__).parent / "tas_seed"

# Tests replace this with an httpx.MockTransport (as app.ai.transport).
transport: httpx.AsyncBaseTransport | None = None


# ── Who may do what ────────────────────────────────────────────────────────

def has_editor_role(p: Principal | None) -> bool:
    return bool(p and p.is_admin and EDITOR_ROLES.intersection(admin_roles.clean(p.admin_roles)))


def can_edit(p: Principal | None) -> bool:
    """Editors change drafts, publish and upload images. Like /admin: the role plus a recent second factor."""
    return has_editor_role(p) and admin_mfa_ok(p)


def may_read(p: Principal | None, collection: str) -> bool:
    return collection in PUBLIC_COLLECTIONS or (collection in EDITOR_COLLECTIONS and can_edit(p))


def readable(p: Principal | None) -> frozenset[str]:
    return COLLECTIONS if can_edit(p) else PUBLIC_COLLECTIONS


def valid_id(doc_id: str) -> bool:
    return bool(DOC_ID.match(doc_id)) and doc_id not in (".", "..")


# ── Documents ──────────────────────────────────────────────────────────────

REV_SQL = "count(*)::text || ':' || coalesce(extract(epoch from max(updated_at))::text, '0')"


async def revs(conn, collections) -> dict[str, str]:
    """A short fingerprint per collection; the browser reads a collection again only when it changed."""
    rows = await db.fetch_all(conn, f"select collection, {REV_SQL} as rev from tas_docs where collection = any(%s)"
                                    " group by collection", (list(collections),))
    out = {c: "0:0" for c in collections}
    out.update({r["collection"]: r["rev"] for r in rows})
    return out


async def list_docs(conn, collection: str) -> dict:
    rows = await db.fetch_all(conn, "select id, data from tas_docs where collection = %s order by id", (collection,))
    rev = (await revs(conn, [collection]))[collection]
    return {"docs": [{"id": r["id"], "data": r["data"]} for r in rows], "rev": rev}


async def get_doc(conn, collection: str, doc_id: str) -> dict | None:
    row = await db.fetch_one(conn, "select data from tas_docs where collection = %s and id = %s", (collection, doc_id))
    return row["data"] if row else None


async def put_doc(conn, collection: str, doc_id: str, data: dict, user_id: int | None) -> None:
    await conn.execute("""insert into tas_docs (collection, id, data, updated_by, updated_at) values (%s, %s, %s, %s, now())
                          on conflict (collection, id) do update
                          set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()""",
                       (collection, doc_id, Jsonb(data), user_id))


def size_of(data) -> int:
    return len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode())


def audit_view(before: dict | None, after: dict | None) -> tuple[dict | None, dict | None]:
    """The fields that changed, for the audit log. Large values (a release's article list) are summarised."""
    b, a = before or {}, after or {}
    keys = sorted({k for k in set(b) | set(a) if b.get(k) != a.get(k)})

    def short(v):
        n = size_of(v)
        return v if n <= 2000 else f"<{n} bytes>"
    return ({k: short(b.get(k)) for k in keys} if before is not None else None,
            {k: short(a.get(k)) for k in keys} if after is not None else None)


# ── Seed ───────────────────────────────────────────────────────────────────

async def seed_if_empty(conn) -> int:
    """Fills an empty instance with the artifact's data and images. Runs at start-up in every container; the advisory
    lock lets one of them do it. Returns the number of documents written (0 when there was already data)."""
    await conn.execute("select pg_advisory_xact_lock(hashtext('tas.seed'))")
    if await db.fetch_one(conn, "select 1 from tas_docs limit 1") or not (SEED_DIR / "docs.json.gz").exists():
        return 0
    seed = json.loads(gzip.decompress((SEED_DIR / "docs.json.gz").read_bytes()))
    n = 0
    for collection, docs in seed.items():
        if collection not in COLLECTIONS:
            continue
        for doc_id, data in docs.items():
            await put_doc(conn, collection, doc_id, data, None)
            n += 1
    for f in sorted((SEED_DIR / "assets").glob("*")):
        content_type = sniff(f.read_bytes()[:16])
        if content_type:
            await conn.execute("""insert into tas_assets (id, content_type, data, size) values (%s, %s, %s, %s)
                                  on conflict (id) do nothing""", (f.stem, content_type, f.read_bytes(), f.stat().st_size))
    return n


def sniff(head: bytes) -> str | None:
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


# ── AI: the simulator's sample.json(prompt) ────────────────────────────────

class AiError(Exception):
    pass


def parse_json(text: str):
    """The model's reply as JSON: the whole text, a fenced block, or the outermost {...}."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    for candidate in (text, fenced.group(1) if fenced else None):
        if candidate:
            try:
                return json.loads(candidate)
            except ValueError:
                pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            pass
    raise AiError("AI-svaret var ikke gyldig JSON")


async def complete_json(prompt: str) -> tuple[object, int, int, bool]:
    """One prompt, one JSON answer (TAS writes its prompts to ask for JSON only). Returns the parsed answer and the
    token usage (prompt, completion, estimated). Prompts and answers are not stored."""
    s = config.settings
    messages = [{"role": "system", "content": "Reply with JSON only, no prose and no code fences."},
                {"role": "user", "content": prompt}]
    payload = {"model": s.ai_model, "messages": messages, "max_tokens": s.ai_max_output_tokens, "temperature": 0.2}
    try:
        async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(90, connect=10)) as client:
            r = await client.post(f"{s.ai_base_url.rstrip('/')}/chat/completions", json=payload,
                                  headers={"Authorization": f"Bearer {s.ai_api_key}"})
    except httpx.HTTPError as e:
        raise AiError("AI-tjenesten kunne ikke nås") from e
    if r.status_code >= 300:
        raise AiError(f"AI-tjenesten svarede {r.status_code}")
    body = r.json()
    text = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    usage = body.get("usage")
    prompt_tokens = int(usage.get("prompt_tokens", 0)) if usage else len(prompt) // 4
    completion_tokens = int(usage.get("completion_tokens", 0)) if usage else len(text) // 4
    return parse_json(text), prompt_tokens, completion_tokens, usage is None
