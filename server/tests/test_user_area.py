"""Mit område (/api/user): the owner's dashboard, sharing as reader or author, and /api/user/<id> for the delegate."""

import asyncio
import io
import json
import zipfile

from tests.test_email_login import email_login


async def _users(make_client):
    admin, owner, reader, author = make_client(), make_client(), make_client(), make_client()
    await email_login(admin, "admin@example.com")  # the first user becomes admin
    await email_login(owner, "anne@example.com")
    await email_login(reader, "sara@example.com")
    await email_login(author, "mikkel@example.com")
    ids = [(await c.get("/api/auth/me")).json()["user"]["id"] for c in (owner, reader, author)]
    return (owner, reader, author), ids


def _actions(owner_conn, where: str = "true") -> list[tuple]:
    return owner_conn.execute(f"select action, table_name, actor_user_id, detail from audit_log where {where} "
                              "order by id").fetchall()


async def test_share_as_reader_and_author(make_client, owner_conn):
    (owner, reader, author), (owner_id, reader_id, author_id) = await _users(make_client)
    await owner.post("/api/clips", json={"title": "Referat", "body": "Hemmeligt"})
    r = await owner.post("/api/files?path=~/noter/", files={"file": ("plan.md", b"# Plan", "text/markdown")})
    file_id = r.json()["id"]

    # Nobody has access before it is given.
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 404
    assert (await reader.get(f"/api/user/{owner_id}/clips")).status_code == 404

    r = await owner.post("/api/user/delegations", json={"email": " Sara@Example.com ", "role": "reader"})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "sara@example.com" and r.json()["user_id"] == reader_id and r.json()["accepted_at"] is None
    assert (await owner.post("/api/user/delegations", json={"email": "sara@example.com", "role": "author"})).status_code == 409
    assert (await owner.post("/api/user/delegations", json={"email": "anne@example.com", "role": "reader"})).status_code == 400
    assert (await owner.post("/api/user/delegations", json={"email": "x", "role": "reader"})).status_code in (400, 422)
    assert (await owner.post("/api/user/delegations", json={"email": "a@b.dk", "role": "admin"})).status_code == 422
    r = await owner.post("/api/user/delegations", json={"email": "mikkel@example.com", "role": "author", "expires_days": 30})
    assert r.status_code == 200 and r.json()["expires_at"] is not None

    # The reader sees it under "Delt med dig" and can read, but not change anything.
    shared = (await reader.get("/api/user/shared")).json()
    assert [(s["owner"]["id"], s["role"]) for s in shared] == [(owner_id, "reader")]
    area = (await reader.get(f"/api/user/{owner_id}")).json()
    assert area["role"] == "reader" and area["can_write"] is False and area["owner"]["email"] == "anne@example.com"
    assert area["stats"]["clips"] == 1 and area["stats"]["files"] == 1
    assert [c["title"] for c in area["clips"]] == ["Referat"]
    assert [f["path"] for f in (await reader.get(f"/api/user/{owner_id}/files")).json()] == [f"/users/{owner_id}/noter/plan.md"]
    r = await reader.get(f"/api/user/{owner_id}/files/{file_id}/link")
    assert r.status_code == 200 and r.json()["url"]
    assert (await reader.post(f"/api/user/{owner_id}/clips", json={"title": "Nyt"})).status_code == 403
    clip_id = area["clips"][0]["id"]
    assert (await reader.patch(f"/api/user/{owner_id}/clips/{clip_id}", json={"title": "Ændret"})).status_code == 403
    assert (await reader.post(f"/api/user/{owner_id}/files", files={"file": ("x.txt", b"x", "text/plain")})).status_code == 403
    # The delegation does not open the owner's own endpoints or the file tree.
    assert (await reader.get(f"/api/files/tree?path=/users/{owner_id}/")).status_code == 404
    assert (await reader.get(f"/api/files/{file_id}")).status_code == 404
    # A delegate cannot see who else has access, nor give access onwards.
    assert (await reader.get("/api/user/delegations")).json() == []

    # The author creates and edits, but never deletes, and never over an existing file.
    r = await author.post(f"/api/user/{owner_id}/clips", json={"title": "Fra Mikkel", "body": "Hej"})
    assert r.status_code == 200, r.text
    new_clip = r.json()["id"]
    assert (await author.patch(f"/api/user/{owner_id}/clips/{clip_id}", json={"body": "Rettet"})).status_code == 200
    r = await author.post(f"/api/user/{owner_id}/files?folder=/noter/", files={"file": ("plan.md", b"ny", "text/markdown")})
    assert r.status_code == 200 and r.json()["filename"] == "plan (2).md" and r.json()["user_id"] == owner_id
    assert (await author.delete(f"/api/clips/{new_clip}")).status_code == 404
    assert (await author.delete(f"/api/files/{file_id}")).status_code == 404
    mine = (await owner.get("/api/clips")).json()
    assert {c["title"] for c in mine} == {"Referat", "Fra Mikkel"}
    assert next(c for c in mine if c["id"] == clip_id)["body"] == "Rettet"

    # Audit: the delegate is the actor, the owner is on_behalf_of; text is logged as a length.
    rows = _actions(owner_conn, "detail ? 'on_behalf_of'")
    assert ("delegation.accepted", "user_delegations", reader_id) in [r[:3] for r in rows]
    assert ("file.download", "files", reader_id) in [r[:3] for r in rows]
    assert ("create", "clips", author_id) in [r[:3] for r in rows]
    assert ("file.upload", "files", author_id) in [r[:3] for r in rows]
    assert all(r[3]["on_behalf_of"] == owner_id and r[3]["via"] == "delegation" for r in rows)
    update = owner_conn.execute("select before, after from audit_log where action = 'update' and table_name = 'clips'").fetchone()
    assert update == ({"body": 9}, {"body": 6, "title": "Referat"})

    # The owner's dashboard shows who has access and what they did.
    ov = (await owner.get("/api/user/overview")).json()
    assert ov["access"]["readers"] == 1 and ov["access"]["authors"] == 1
    assert ov["stats"]["clips"] == 2 and ov["stats"]["files"] == 2
    acts = [(a["action"], a["actor"]["id"] if a["actor"] else None) for a in ov["activity"]]
    assert ("create", author_id) in acts and ("file.download", reader_id) in acts and ("create", None) in acts
    # And the delegates do not see the owner's activity in theirs.
    assert all(a["mine"] for a in (await reader.get("/api/user/overview")).json()["activity"])


async def test_change_role_expire_revoke_and_leave(make_client, owner_conn):
    (owner, reader, _), (owner_id, reader_id, _) = await _users(make_client)
    grant = (await owner.post("/api/user/delegations", json={"email": "sara@example.com", "role": "reader"})).json()

    r = await owner.patch(f"/api/user/delegations/{grant['id']}", json={"role": "author"})
    assert r.json()["role"] == "author"
    assert (await reader.post(f"/api/user/{owner_id}/clips", json={"title": "Nu må jeg"})).status_code == 200
    # Someone else's delegation cannot be changed.
    assert (await reader.patch(f"/api/user/delegations/{grant['id']}", json={"role": "reader"})).status_code == 404

    owner_conn.execute("update user_delegations set expires_at = now() - interval '1 minute'")
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 404
    assert (await reader.get("/api/user/shared")).json() == []
    assert (await owner.get("/api/user/delegations")).json()[0]["expired"] is True
    r = await owner.patch(f"/api/user/delegations/{grant['id']}", json={"never_expires": True})
    assert r.json()["expires_at"] is None
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 200

    # A blocked owner's area is closed.
    owner_conn.execute("update users set blocked_at = now() where id = %s", (owner_id,))
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 404
    owner_conn.execute("update users set blocked_at = null where id = %s", (owner_id,))

    # The delegate may give up access; the owner may revoke it.
    assert (await reader.delete(f"/api/user/shared/{grant['id']}")).status_code == 200
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 404
    grant = (await owner.post("/api/user/delegations", json={"email": "sara@example.com", "role": "reader"})).json()
    assert (await owner.delete(f"/api/user/delegations/{grant['id']}")).status_code == 200
    assert (await reader.get(f"/api/user/{owner_id}")).status_code == 404
    deletes = _actions(owner_conn, "table_name = 'user_delegations' and action = 'delete'")
    assert [(r[2], r[3].get("by_delegate")) for r in deletes] == [(reader_id, True), (owner_id, None)]


async def test_pending_invite_is_claimed_on_first_login(make_client, owner_conn):
    owner, later = make_client(), make_client()
    await email_login(owner, "anne@example.com")
    owner_id = (await owner.get("/api/auth/me")).json()["user"]["id"]
    g = (await owner.post("/api/user/delegations", json={"email": "jens@example.com", "role": "reader"})).json()
    assert g["user_id"] is None and g["accepted_at"] is None

    await email_login(later, "jens@example.com")
    later_id = (await later.get("/api/auth/me")).json()["user"]["id"]
    assert [s["owner"]["id"] for s in (await later.get("/api/user/shared")).json()] == [owner_id]
    # The page loads several endpoints at once; the first visit is logged once.
    rs = await asyncio.gather(later.get(f"/api/user/{owner_id}"), later.get(f"/api/user/{owner_id}/clips"),
                              later.get(f"/api/user/{owner_id}/files"))
    assert [r.status_code for r in rs] == [200, 200, 200]
    assert owner_conn.execute("select count(*) from audit_log where action = 'delegation.accepted'").fetchone()[0] == 1
    g = (await owner.get("/api/user/delegations")).json()[0]
    assert g["user_id"] == later_id and g["accepted_at"] is not None

    # Expired access is cleaned up by the retention policy.
    from app import retention
    owner_conn.execute("update user_delegations set expires_at = now() - interval '40 days'")
    assert (await retention.cleanup(only="user_delegations"))["user_delegations"] == 1


async def test_gdpr_export_and_erasure(make_client, owner_conn):
    (owner, reader, author), (owner_id, reader_id, _) = await _users(make_client)
    await owner.post("/api/user/delegations", json={"email": "sara@example.com", "role": "reader"})
    await owner.post("/api/user/delegations", json={"email": "ukendt@example.com", "role": "author"})
    await reader.post("/api/user/delegations", json={"email": "anne@example.com", "role": "author"})
    await owner.post("/api/user/delegations", json={"email": "mikkel@example.com", "role": "author"})
    await author.post(f"/api/user/{owner_id}/clips", json={"title": "Fra Mikkel"})

    r = await owner.get("/api/me/export")
    data = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("data.json"))
    assert {d["delegate_email"] for d in data["delegations_given"]} == {"sara@example.com", "ukendt@example.com",
                                                                       "mikkel@example.com"}
    assert [d["owner_id"] for d in data["delegations_received"]] == [reader_id]

    # Erasing the owner removes their delegations both ways and what delegates did in their area from the log.
    r = await owner.post("/api/me/delete", json={"confirm": "anne@example.com"})
    assert r.status_code == 200, r.text
    assert owner_conn.execute("select count(*) from user_delegations").fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from audit_log where detail ? 'on_behalf_of' "
                              "and (detail ->> 'on_behalf_of')::bigint = %s", (owner_id,)).fetchone()[0] == 0
