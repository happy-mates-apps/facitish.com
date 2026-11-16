"""TAS, the terminal simulator (app/tas.py, routes/tas.py): who reads and writes which collections, audit,
images, the seed, the pages on /w/ and /backoffice, and the AI bridge."""

import dataclasses
import json

import httpx

from app import config, db, tas
from tests.helpers import full_user

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def _editor_and_user(make_client):
    """The first user is super admin (Fuld adgang); the second is a plain user."""
    editor = make_client()
    await full_user(editor, "11111111")
    user = make_client()
    await full_user(user, "22222222")
    return editor, user


async def test_editors_write_drafts_and_publish_everyone_reads_the_published(make_client, client, owner_conn):
    editor, user = await _editor_and_user(make_client)
    r = await editor.put("/api/tas/docs/nodes/m35-x", json={"data": {"modelId": "move3500", "label": "Purchase"}})
    assert r.status_code == 200 and r.json()["data"]["label"] == "Purchase"
    r = await editor.patch("/api/tas/docs/nodes/m35-x", json={"data": {"order": 10}})
    assert r.json()["data"] == {"modelId": "move3500", "label": "Purchase", "order": 10}
    assert (await editor.put("/api/tas/docs/published/move3500", json={"data": {"version": 1, "nodes": []}})).status_code == 200

    # Drafts are for editors; the published release is for everyone, also anonymous visitors on /w/.
    assert (await user.get("/api/tas/docs/nodes")).status_code == 403
    assert (await client.get("/api/tas/docs/nodes/m35-x")).status_code == 403
    assert (await client.get("/api/tas/docs/published/move3500")).json()["data"]["version"] == 1
    listed = (await editor.get("/api/tas/docs/nodes")).json()
    assert [d["id"] for d in listed["docs"]] == ["m35-x"] and listed["rev"].startswith("1:")

    # Only editors write, whatever the collection.
    assert (await user.put("/api/tas/docs/published/move3500", json={"data": {}})).status_code == 403
    assert (await client.put("/api/tas/docs/published/move3500", json={"data": {}}, headers={"X-Gaer": "1"})).status_code in (401, 403)

    # The poll fingerprint covers what the caller may read.
    anon = (await client.get("/api/tas/rev")).json()["revs"]
    assert "published" in anon and "nodes" not in anon
    assert "nodes" in (await editor.get("/api/tas/rev")).json()["revs"]

    assert (await editor.delete("/api/tas/docs/nodes/m35-x")).status_code == 204
    actions = [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name = 'tas_docs' order by id").fetchall()]
    assert actions == ["tas.doc.set", "tas.doc.update", "tas.doc.set", "tas.doc.delete"]
    before, after = owner_conn.execute("""select before, after from audit_log where action = 'tas.doc.update'""").fetchone()
    assert before == {"order": None} and after == {"order": 10}


async def test_unknown_collections_and_ids_are_refused(make_client):
    editor, _ = await _editor_and_user(make_client)
    assert (await editor.get("/api/tas/docs/users")).status_code == 404
    assert (await editor.put("/api/tas/docs/secrets/x", json={"data": {}})).status_code == 404
    assert (await editor.put("/api/tas/docs/nodes/a%20b", json={"data": {}})).status_code == 400
    assert (await editor.patch("/api/tas/docs/nodes/missing", json={"data": {"a": 1}})).status_code == 404


async def test_admins_without_the_content_role_cannot_edit(make_client, owner_conn):
    editor, user = await _editor_and_user(make_client)
    uid = owner_conn.execute("select id from users where phone like '%22222222'").fetchone()[0]
    owner_conn.execute("update users set role = 'admin', admin_roles = '{support}' where id = %s", (uid,))
    assert (await user.put("/api/tas/docs/nodes/n1", json={"data": {}})).status_code == 403
    owner_conn.execute("update users set admin_roles = '{indhold}' where id = %s", (uid,))
    assert (await user.put("/api/tas/docs/nodes/n1", json={"data": {}})).status_code == 200


async def test_images_upload_for_editors_and_serve_to_everyone(make_client, client, owner_conn):
    editor, user = await _editor_and_user(make_client)
    files = {"file": ("x.png", PNG, "image/png")}
    assert (await user.post("/api/tas/assets", files=files)).status_code == 403
    r = await editor.post("/api/tas/assets", files=files)
    assert r.status_code == 200, r.text
    got = await client.get(r.json()["url"])
    assert got.status_code == 200 and got.content == PNG and got.headers["content-type"] == "image/png"
    assert (await editor.post("/api/tas/assets", files={"file": ("x.txt", b"hello", "text/plain")})).status_code == 400
    assert owner_conn.execute("select count(*) from audit_log where action = 'tas.asset.upload'").fetchone()[0] == 1


async def test_seed_fills_an_empty_instance_once():
    async with db.connection() as conn:
        n = await tas.seed_if_empty(conn)
    assert n > 500
    async with db.connection() as conn:
        assert await tas.seed_if_empty(conn) == 0
        model = await tas.get_doc(conn, "models", "move3500")
        images = await db.fetch_one(conn, "select count(*) as n from tas_assets")
    assert model["shortName"] == "Move/3500" and images["n"] == 14


async def test_front_page_and_backoffice_pages(client, make_client, owner_conn):
    owner_conn.execute("""insert into settings (key, value) values ('web_front', '"tas"')
                          on conflict (key) do update set value = excluded.value""")
    page = await client.get("/w/")
    assert page.status_code == 200 and "Terminal Assistance Simulator" in page.text
    assert "/w/tas/env.js?mode=public" in page.text and "<script>" not in page.text  # CSP: no inline scripts
    env = (await client.get("/w/tas/env.js?mode=public")).text
    assert '"signedIn": false' in env and '"canEdit": false' in env
    for name in ("gaer.js", "app.js", "mark.js"):
        r = await client.get(f"/w/tas/{name}?v=1")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/javascript")
    assert (await client.get("/w/tas/index.html")).status_code == 404
    # The backoffice frame needs a login; editors get the Admin Portal.
    r = await client.get("/w/tas/backoffice", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/login?next=/backoffice"
    editor, user = await _editor_and_user(make_client)
    assert "mode=backoffice" in (await editor.get("/w/tas/backoffice")).text
    assert '"canEdit": true' in (await editor.get("/w/tas/env.js?mode=backoffice")).text
    assert '"canEdit": false' in (await user.get("/w/tas/env.js?mode=backoffice")).text


async def test_ai_answers_json_and_counts_tokens(make_client, monkeypatch, owner_conn):
    _, user = await _editor_and_user(make_client)
    assert (await user.post("/api/tas/ai", json={"prompt": "hi"})).status_code == 404  # AI is off
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, ai_api_key="test-key"))

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["messages"][1]["content"] == "Which key?"
        return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"ids": ["a1"]}\n```'}}],
                                         "usage": {"prompt_tokens": 12, "completion_tokens": 5}})
    monkeypatch.setattr(tas, "transport", httpx.MockTransport(handler))
    r = await user.post("/api/tas/ai", json={"prompt": "Which key?"})
    assert r.status_code == 200 and r.json() == {"result": {"ids": ["a1"]}}
    assert owner_conn.execute("select surface, prompt_tokens, completion_tokens from ai_usage").fetchone() == ("tas", 12, 5)
    assert '"ai": true' in (await user.get("/w/tas/env.js")).text


def test_parse_json_finds_the_object():
    assert tas.parse_json('{"a": 1}') == {"a": 1}
    assert tas.parse_json('Here: {"a": [1, 2]} done') == {"a": [1, 2]}
