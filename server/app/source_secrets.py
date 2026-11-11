"""Secrets for API sources (/admin/data/connect) from Hemmeligheder (/admin/secrets).

A kildebeskrivelse names each secret it needs (app/data_sources.py: spec["secrets"]) as "gruppe/navn[@miljø]", or as
an environment variable DATA_SECRET_… (the older way). This module turns those names into values for one call:

- A source may use a secret's value only while it holds an active grant with level `use` ("Brug i kilde"). The grant
  comes from an access request approved by the secret's A, R and C (app/secret_store.py), and it always expires.
  Nobody can see the value through it; the server only puts it in the request to the source's hosts.
- A test call (POST /api/admin/data/sources/test) may also use the tester's own access to the value (A, R or a grant
  to see it), because they could see the value anyway. That use is audited on the secret.
- The newest version is always used, so when R changes the value the source follows without a new approval.
"""

from app import db, secret_store
from app.config import data_secret
from app.data_sources import SECRET_REF_RE, is_env_ref
from app.logs import RequestMeta, audit

HOW = {"source": "Kilden har adgang (Brug i kilde)", "own": "Bruger din egen adgang til testen",
       "env": "Miljøvariabel på instansen"}


async def find(conn, ref: str) -> dict | None:
    """The live secret a reference names, or None."""
    m = SECRET_REF_RE.match(ref)
    if not m:
        return None
    return await db.fetch_one(conn, f"""
        select {secret_store.SECRET_COLUMNS}, g.slug as group_slug from secrets s join groups g on g.id = s.group_id
        where g.slug = %s and lower(s.name) = lower(%s) and s.environment = %s and s.archived_at is null""",
        (m["group"], m["name"], m["env"] or ""))


def ref_of(secret: dict) -> str:
    return f"{secret['group_slug']}/{secret['name']}" + (f"@{secret['environment']}" if secret["environment"] else "")


async def source_grant(conn, secret_id: int, source_id: int | None) -> dict | None:
    if source_id is None:
        return None
    return await db.fetch_one(conn, """select id, expires_at from secret_grants where secret_id = %s and source_id = %s
                                       and level = 'use' and ended_at is null and expires_at > now()
                                       order by expires_at desc limit 1""", (secret_id, source_id))


async def pending_request(conn, secret_id: int, source_id: int | None) -> dict | None:
    if source_id is None:
        return None
    row = await db.fetch_one(conn, """select id, expires_at from secret_access_requests where secret_id = %s
                                      and grantee_source_id = %s and status = 'pending'""", (secret_id, source_id))
    if row:
        appr = await secret_store.approvals(conn, row["id"])
        row["approved"], row["total"] = sum(a["decision"] == "approved" for a in appr), len(appr)
    return row


async def resolve(conn, spec: dict, *, source_id: int | None, tester: dict | None = None,
                  meta: RequestMeta | None = None) -> tuple[dict[str, str], list[dict]]:
    """Values by name for the secrets the description needs, and one status per secret for the checks.
    `tester` is the user row of an admin running a test call (their own access may be used); None for real calls."""
    values: dict[str, str] = {}
    status: list[dict] = []
    for item in spec.get("secrets", []):
        ref = item["ref"]
        if ref in values:
            continue
        if is_env_ref(ref):
            value = data_secret(ref)
            if value:
                values[ref] = value
            status.append({"ref": ref, "used_as": item["used_as"], "kind": "env", "ok": bool(value),
                           "how": "env" if value else None,
                           "text": f"Miljøvariablen {ref} er " + ("sat. Flyt den gerne til Hemmeligheder" if value
                                                                  else "ikke sat på instansen")})
            continue
        secret = await find(conn, ref)
        if secret is None:
            status.append({"ref": ref, "used_as": item["used_as"], "kind": "vault", "ok": False, "how": None,
                           "text": f"Hemmeligheden {ref} findes ikke i Hemmeligheder"})
            continue
        grant = await source_grant(conn, secret["id"], source_id)
        how = "source" if grant else None
        if how is None and tester is not None and await secret_store.access_level(conn, secret, tester):
            how = "own"
        entry = {"ref": ref, "used_as": item["used_as"], "kind": "vault", "secret_id": secret["id"], "ok": how is not None,
                 "how": how, "grant_expires_at": grant["expires_at"] if grant else None}
        if how is None:
            pending = await pending_request(conn, secret["id"], source_id)
            entry["pending"] = pending
            entry["text"] = (f"{ref}: anmodning om Brug i kilde afventer ({pending['approved']} af {pending['total']})"
                             if pending else f"Kilden har ikke adgang til {ref}. Anmod om Brug i kilde")
        else:
            entry["text"] = f"{ref}: {HOW[how]}"
            values[ref] = await secret_store.read_value(conn, secret["id"], secret["current_version"])
            if how == "own":
                await audit(conn, "secret.used_in_test", actor_id=tester["id"], meta=meta or RequestMeta(),
                            table="secrets", row_id=secret["id"], source_key=spec["key"], version=secret["current_version"])
        status.append(entry)
    return values, status


async def sync(conn, source_id: int, spec: dict) -> None:
    """Records which secrets a saved source names (shown on the secret's page as "Bruges af")."""
    await conn.execute("delete from data_source_secrets where source_id = %s", (source_id,))
    for item in spec.get("secrets", []):
        if is_env_ref(item["ref"]):
            continue
        secret = await find(conn, item["ref"])
        if secret:
            await conn.execute("""insert into data_source_secrets (source_id, secret_id, used_as) values (%s, %s, %s)
                                  on conflict do nothing""", (source_id, secret["id"], item["used_as"]))
