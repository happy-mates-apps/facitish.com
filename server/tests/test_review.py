"""The review panel's backend: login required, own data only, sessions, attachments, zip, GDPR and logs."""

import io
import json
import zipfile

from tests.helpers import full_user, otp_login

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64


async def test_review_requires_login(make_client):
    anon = make_client()
    for method, path in (("get", "/api/review/features"), ("get", "/api/review/feedback"),
                         ("get", "/api/review/sessions"), ("get", "/api/review/export.zip")):
        assert (await getattr(anon, method)(path)).status_code == 401, path
    r = await anon.post("/api/review/feedback", json={"path": "/", "body": "x"})
    assert r.status_code == 401


async def test_feedback_with_attachments_is_private_and_audited(make_client, owner_conn):
    admin = make_client()
    await full_user(admin, "11111111")
    user, other = make_client(), make_client()
    await otp_login(user, "22222222")
    await otp_login(other, "33333333")

    r = await user.post("/api/review/feedback", json={
        "path": "/klip", "body": "  Knappen er for lille  ", "impression": "bad", "feature_key": "klip", "ring": 3,
        "target": {"kind": "element", "selector": "main > button", "text": "Gem"}})
    assert r.status_code == 201, r.text
    note = r.json()
    assert note["body"] == "Knappen er for lille" and note["attachments"] == []

    assert (await user.post("/api/review/feedback", json={"path": "/klip"})).status_code == 400  # nothing to say
    assert (await user.post("/api/review/feedback", json={"path": "klip", "body": "x"})).status_code == 422
    assert (await user.post("/api/review/feedback",
                            json={"path": "/", "body": "x", "target": {"t": "x" * 5000}})).status_code == 422

    r = await user.post(f"/api/review/feedback/{note['id']}/attachments", data={"kind": "screenshot"},
                        files={"file": ("x.png", PNG, "text/plain")})
    assert r.status_code == 201, r.text
    shot = r.json()
    assert shot["content_type"] == "image/png"
    r = await user.post(f"/api/review/feedback/{note['id']}/attachments", data={"kind": "audio"},
                        files={"file": ("lyd", WEBM, "audio/webm")})
    assert r.status_code == 201 and r.json()["content_type"] == "audio/webm"
    r = await user.post(f"/api/review/feedback/{note['id']}/attachments", data={"kind": "screenshot"},
                        files={"file": ("x.png", b"<svg/>", "image/png")})
    assert r.status_code == 400  # checked by content

    assert (await user.get(shot["url"])).content == PNG
    assert (await other.get(shot["url"])).status_code == 404
    assert (await admin.get(shot["url"])).status_code == 200
    # Review files never show up among the user's own files.
    assert (await user.get("/api/files")).json() == []

    mine = (await user.get("/api/review/feedback?path=/klip")).json()
    assert [n["id"] for n in mine] == [note["id"]] and len(mine[0]["attachments"]) == 2
    assert (await other.get("/api/review/feedback")).json() == []
    assert (await other.patch(f"/api/review/feedback/{note['id']}", json={"body": "hack"})).status_code == 404

    assert (await user.patch(f"/api/review/feedback/{note['id']}", json={"body": "Større knap", "impression": ""})).status_code == 200
    row = owner_conn.execute("""select before, after from audit_log
                                where table_name = 'review_feedback' and action = 'update'""").fetchone()
    assert row == ({"body": 20, "impression": "bad"}, {"body": 11, "impression": None})

    features = {f["key"]: f for f in (await other.get("/api/review/features")).json()["features"]}
    assert features["klip"]["feedback"] == 1 and features["klip"]["mine"] == 0

    assert (await user.delete(f"/api/review/feedback/{note['id']}")).status_code == 200
    assert owner_conn.execute("select count(*) from files where kind = 'review'").fetchone()[0] == 0
    actions = [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name in ('review_feedback', 'files') order by id")]
    assert actions == ["create", "file.upload", "file.upload", "update", "file.delete", "file.delete", "delete"]


async def test_session_flow_and_zip(make_client, owner_conn):
    user = make_client()
    await otp_login(user, "44444444")
    persona = {"name": "Henrik, direktør", "who": "Leder", "wants": "Et klart ja", "worries": "Pris", "ring": 3}
    r = await user.post("/api/review/sessions", json={
        "persona_key": "henrik", "persona": persona, "script_key": "ja-nej", "script_title": "Henrik skal sige ja",
        "ring": 3, "tasks": [{"id": "t1", "title": "Find prisen"}, {"id": "t2", "title": "Log ud"}]})
    assert r.status_code == 201, r.text
    session = r.json()
    assert session["tasks"][0]["status"] == "open" and session["ended_at"] is None

    for path in ("/", "/klip", "/klip", "/filer"):
        r = await user.post(f"/api/review/sessions/{session['id']}/visit", json={"path": path})
    assert r.json() == {"pages": 3}

    r = await user.post("/api/review/feedback", json={"path": "/filer", "body": "Hvor er prisen?", "impression": "meh",
                                                     "session_id": session["id"], "task_id": "t1",
                                                     "target": {"kind": "area", "x": 10, "y": 20, "w": 300, "h": 120}})
    note = r.json()
    await user.post(f"/api/review/feedback/{note['id']}/attachments", data={"kind": "screenshot"},
                    files={"file": ("s.png", PNG, "image/png")})

    r = await user.patch(f"/api/review/sessions/{session['id']}",
                         json={"tasks": [{"id": "t1", "status": "stuck"}, {"id": "t2", "status": "done"}],
                               "notes": "Prisen mangler", "end": True})
    assert r.status_code == 200
    ended = r.json()
    assert ended["ended_at"] and [t["status"] for t in ended["tasks"]] == ["stuck", "done"] and ended["feedback"] == 1
    assert (await user.patch(f"/api/review/sessions/{session['id']}", json={"end": True})).status_code == 409
    assert (await user.post(f"/api/review/sessions/{session['id']}/visit", json={"path": "/"})).status_code == 409
    r = await user.patch(f"/api/review/sessions/{session['id']}", json={"tasks": [{"id": "x", "status": "done"}]})
    assert r.status_code == 409

    r = await user.get(f"/api/review/sessions/{session['id']}/zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert {"README.md", "session.json", "feedback.json", f"screenshots/note-{note['id']}-1.png"} <= names
    readme = z.read("README.md").decode()
    assert "Henrik, direktør" in readme and "Find prisen (gået i stå)" in readme and "[x] Log ud" in readme
    assert "Hvor er prisen?" in readme and "område 300×120" in readme
    assert json.loads(z.read("session.json"))["pages"][1]["path"] == "/klip"
    assert z.read(f"screenshots/note-{note['id']}-1.png") == PNG

    # A second session ends the running one; only one runs at a time.
    s2 = (await user.post("/api/review/sessions", json={"persona": {"name": "Fri"}})).json()
    s3 = (await user.post("/api/review/sessions", json={"persona": {"name": "Fri igen"}})).json()
    sessions = {s["id"]: s for s in (await user.get("/api/review/sessions")).json()}
    assert sessions[s2["id"]]["ended_at"] and sessions[s3["id"]]["ended_at"] is None

    other = make_client()
    await otp_login(other, "55555555")
    assert (await other.get(f"/api/review/sessions/{session['id']}/zip")).status_code == 404
    assert (await other.delete(f"/api/review/sessions/{session['id']}")).status_code == 404

    assert (await user.delete(f"/api/review/sessions/{session['id']}")).status_code == 200
    assert owner_conn.execute("select count(*) from review_feedback where session_id = %s",
                              (session["id"],)).fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from files where kind = 'review'").fetchone()[0] == 0


async def test_review_data_in_gdpr_export_and_erasure(make_client, owner_conn):
    await full_user(make_client(), "11111111")  # someone else is admin, so the user may delete their account
    user = make_client()
    await otp_login(user, "66666666")
    s = (await user.post("/api/review/sessions", json={"persona": {"name": "Mette"}})).json()
    note = (await user.post("/api/review/feedback", json={"path": "/", "body": "Hej", "session_id": s["id"]})).json()
    await user.post(f"/api/review/feedback/{note['id']}/attachments", data={"kind": "audio"},
                    files={"file": ("a", WEBM, "audio/webm")})

    r = await user.get("/api/me/export")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    data = json.loads(z.read("data.json"))
    assert data["review_sessions"][0]["persona"]["name"] == "Mette"
    assert data["review_feedback"][0]["body"] == "Hej" and len(data["review_feedback"][0]["file_ids"]) == 1
    assert any(n.startswith("files/") for n in z.namelist())

    user_id = owner_conn.execute("select id from users where phone = '+4566666666'").fetchone()[0]
    assert (await user.post("/api/me/delete", json={"confirm_phone": "66666666"})).status_code == 200
    for table in ("review_sessions", "review_feedback"):
        assert owner_conn.execute(f"select count(*) from {table} where user_id = %s", (user_id,)).fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from files where user_id = %s", (user_id,)).fetchone()[0] == 0
