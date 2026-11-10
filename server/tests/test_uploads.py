"""Direct upload to Object Storage and zip files unpacked into the tree (app/uploads.py, migration 0021)."""

import dataclasses
import io
import json
import zipfile
from urllib.parse import urlsplit

from app import config, jobs, uploads
from app.storage import get_storage
from tests.helpers import full_user, otp_login


async def _two(make_client):
    admin, user = make_client(), make_client()
    await full_user(admin, "11111111")
    await otp_login(user, "22222222")
    return admin, user


async def _me(client) -> int:
    return (await client.get("/api/auth/me")).json()["user"]["id"]


async def _put(client, url: str, data: bytes, headers: dict | None = None):
    """What the browser does with a presigned link (the memory backend's links point at the server)."""
    parts = urlsplit(url)
    r = await client.put(parts.path + ("?" + parts.query if parts.query else ""), content=data, headers=headers or {})
    assert r.status_code == 200, r.text
    return r


def _actions(owner_conn) -> list[str]:
    return [r[0] for r in owner_conn.execute("select action from audit_log order by id").fetchall()]


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


async def test_direct_upload_single_put(make_client, owner_conn):
    admin, user = await _two(make_client)
    me = await _me(user)
    data = b"%PDF-1.4 hej"
    start = (await user.post("/api/files/uploads", json={"path": "~/docs/", "filename": "rapport.pdf", "size": len(data),
                                                         "content_type": "application/pdf"})).json()
    assert start["multipart"] is False and start["content_type"] == "application/pdf"
    await _put(user, start["url"], data, {"content-type": start["content_type"]})
    done = (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()
    assert done["status"] == "done" and done["result"]["file"]["path"] == f"/users/{me}/docs/rapport.pdf"
    # Completing again (a retry) gives the same answer and no second file.
    again = (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()
    assert again["status"] == "done"
    tree = (await user.get("/api/files/tree?path=~/docs/")).json()
    assert [f["filename"] for f in tree["files"]] == ["rapport.pdf"] and tree["files"][0]["size_bytes"] == len(data)
    link = (await user.get(f"/api/files/{tree['files'][0]['id']}/link")).json()["url"]
    assert (await user.get(link)).content == data
    row = owner_conn.execute("""select detail from audit_log where action = 'file.upload'""").fetchone()
    assert row[0]["via"] == "direct" and row[0]["upload_id"] == start["id"]

    # Someone else's upload is not found; a user cannot upload into another home.
    assert (await admin.get(f"/api/files/uploads/{start['id']}")).status_code == 404
    admin_id = await _me(admin)
    r = await user.post("/api/files/uploads", json={"path": f"/users/{admin_id}/", "filename": "x.txt", "size": 1})
    assert r.status_code == 404
    # The limit is MAX_DIRECT_UPLOAD_MB, not MAX_UPLOAD_MB.
    big = config.settings.max_direct_upload_mb * 1024 * 1024 + 1
    assert (await user.post("/api/files/uploads", json={"path": "~/", "filename": "x.bin", "size": big})).status_code == 413
    ok = await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "stor.bin", "size": 200 * 1024 * 1024})
    assert ok.status_code == 200 and ok.json()["multipart"] is True


async def test_direct_upload_multipart_and_size_check(make_client, owner_conn, monkeypatch):
    _, user = await _two(make_client)
    monkeypatch.setattr(uploads, "SINGLE_PUT_MAX", 10)
    monkeypatch.setattr(uploads, "PART_SIZE", 8)
    monkeypatch.setattr(uploads, "MB", 1)  # part sizes in bytes for the test
    data = b"0123456789abcdefghij"  # 20 bytes → 3 parts of 8
    start = (await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "data.bin", "size": len(data)})).json()
    assert start["multipart"] is True and start["parts"] == 3 and start["part_size"] == 8
    uid = start["id"]
    assert (await user.post(f"/api/files/uploads/{uid}/parts", json={"numbers": [4]})).status_code == 400
    urls = (await user.post(f"/api/files/uploads/{uid}/parts", json={"numbers": [1, 2, 3]})).json()["urls"]
    etags = []
    for n in (1, 2, 3):
        r = await _put(user, urls[str(n)], data[(n - 1) * 8:n * 8])
        etags.append({"number": n, "etag": r.headers["etag"]})
    # All parts must be there.
    assert (await user.post(f"/api/files/uploads/{uid}/complete", json={"parts": etags[:2]})).status_code == 400
    done = (await user.post(f"/api/files/uploads/{uid}/complete", json={"parts": etags})).json()
    assert done["status"] == "done" and done["result"]["file"]["size_bytes"] == 20
    key = owner_conn.execute("select storage_key from files where filename = 'data.bin'").fetchone()[0]
    assert get_storage().objects[key][0] == data

    # A file that is not the size announced is refused and removed.
    start = (await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "kort.txt", "size": 5})).json()
    await _put(user, start["url"], b"123")
    failed = (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()
    assert failed["status"] == "failed" and "størrelse" in failed["error"]
    assert owner_conn.execute("select count(*) from files where filename = 'kort.txt'").fetchone()[0] == 0

    # Aborting removes the object; completing an aborted upload changes nothing.
    start = (await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "nej.txt", "size": 3})).json()
    await _put(user, start["url"], b"nej")
    assert (await user.delete(f"/api/files/uploads/{start['id']}")).json()["status"] == "aborted"
    assert (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()["status"] == "aborted"
    assert not any(k.endswith(start["id"]) for k in get_storage().objects)


async def test_unzip_into_folder(make_client, owner_conn):
    _, user = await _two(make_client)
    me = await _me(user)
    data = _zip({"a.txt": b"A", "billeder/b.png": b"\x89PNG", "billeder/dybt/c.md": b"# C",
                 "__MACOSX/._a.txt": b"x", "billeder/.DS_Store": b"x", "../ud.txt": b"nej"})
    start = (await user.post("/api/files/uploads", json={"path": "~/", "filename": "Projekt.zip", "size": len(data),
                                                         "unzip": True, "into_folder": True})).json()
    await _put(user, start["url"], data, {"content-type": start["content_type"]})
    up = (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()
    assert up["status"] == "unpacking" and up["path"] == f"/users/{me}/Projekt/"
    await jobs.run_pending()
    up = (await user.get(f"/api/files/uploads/{start['id']}")).json()
    assert up["status"] == "done", up
    assert up["result"]["files"] == 3 and up["result"]["total"] == 3
    assert [s["name"] for s in up["result"]["skipped"]] == ["../ud.txt"]
    tree = (await user.get("/api/files/tree?path=~/Projekt/billeder/")).json()
    assert [f["filename"] for f in tree["files"]] == ["b.png"] and [f["name"] for f in tree["folders"]] == ["dybt"]
    text = (await user.get(f"/api/files/by-path?path=~/Projekt/billeder/dybt/c.md")).json()
    assert text["text"] == "# C" and text["content_type"] == "text/markdown"
    # The zip itself is gone; no zip file in the tree.
    assert f"uploads/{start['id']}" not in get_storage().objects
    assert owner_conn.execute("select count(*) from files where filename like '%%.zip'").fetchone()[0] == 0
    actions = _actions(owner_conn)
    assert actions.count("file.upload") == 3 and "file.unzip" in actions


async def test_zip_as_is_and_unzip_via_server(make_client, owner_conn):
    admin, user = await _two(make_client)
    data = _zip({"x.txt": b"x", "y/z.txt": b"z"})
    # As it is: an ordinary upload.
    start = (await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "arkiv.zip", "size": len(data)})).json()
    await _put(user, start["url"], data)
    assert (await user.post(f"/api/files/uploads/{start['id']}/complete", json={})).json()["result"]["file"]["filename"] == "arkiv.zip"
    # Only zip files can be unpacked.
    r = await user.post("/api/files/uploads", json={"path": "/shared/", "filename": "a.txt", "size": 1, "unzip": True})
    assert r.status_code == 400
    # The fallback through the server, into the folder itself; the admin API does the same.
    r = (await user.post("/api/files?path=/shared/&unzip=true", files={"file": ("pakke.zip", data, "application/zip")})).json()
    assert r["upload"]["status"] == "unpacking"
    admin_id = await _me(admin)
    r = await admin.post(f"/api/admin/files/upload?path=/users/{admin_id}/&unzip=true&into_folder=true",
                         files={"file": ("adm.zip", data, "application/zip")})
    assert r.json()["upload"]["path"] == f"/users/{admin_id}/adm/"
    await jobs.run_pending()
    shared = (await user.get("/api/files/tree?path=/shared/")).json()
    assert sorted(f["filename"] for f in shared["files"]) == ["arkiv.zip", "x.txt"]
    assert [f["name"] for f in shared["folders"]] == ["y"]
    assert (await admin.get(f"/api/admin/files/tree?path=/users/{admin_id}/adm/y/")).json()["files"][0]["filename"] == "z.txt"


async def test_unzip_limits_and_bad_zip(make_client, monkeypatch):
    _, user = await _two(make_client)
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, unzip_max_files=1))
    data = _zip({"a.txt": b"a", "b.txt": b"b"})
    r = (await user.post("/api/files?path=~/&unzip=true", files={"file": ("to.zip", data, "application/zip")})).json()
    bad = (await user.post("/api/files?path=~/&unzip=true", files={"file": ("bad.zip", b"not a zip", "application/zip")})).json()
    await jobs.run_pending()
    first = (await user.get(f"/api/files/uploads/{r['upload']['id']}")).json()
    assert first["status"] == "failed" and "højst 1" in first["error"]
    second = (await user.get(f"/api/files/uploads/{bad['upload']['id']}")).json()
    assert second["status"] == "failed" and "zip" in second["error"]
    assert (await user.get("/api/files/tree")).json()["files"] == []
    assert not any(k.startswith("uploads/") for k in get_storage().objects)


async def test_unzip_continues_in_batches(make_client, monkeypatch):
    _, user = await _two(make_client)
    clock = iter(range(0, 100_000, 400))  # every look at the clock is 400 s later: one file per run
    monkeypatch.setattr(uploads, "_clock", lambda: next(clock))
    data = _zip({"1.txt": b"1", "2.txt": b"2", "3.txt": b"3"})
    r = (await user.post("/api/files?path=~/&unzip=true", files={"file": ("tre.zip", data, "application/zip")})).json()
    for _ in range(6):
        await jobs.run_pending()
    up = (await user.get(f"/api/files/uploads/{r['upload']['id']}")).json()
    assert up["status"] == "done" and up["result"]["files"] == 3
    assert sorted(f["filename"] for f in (await user.get("/api/files/tree")).json()["files"]) == ["1.txt", "2.txt", "3.txt"]


async def test_unfinished_uploads_are_cleaned_up(make_client, owner_conn):
    _, user = await _two(make_client)
    start = (await user.post("/api/files/uploads", json={"path": "~/", "filename": "halv.bin", "size": 3})).json()
    await _put(user, start["url"], b"abc")
    owner_conn.execute("update file_uploads set expires_at = now() - interval '1 minute'")
    assert (await uploads.uploads_cleanup({}, {}))["aborted"] == 1
    assert (await user.get(f"/api/files/uploads/{start['id']}")).json()["status"] == "aborted"
    assert not get_storage().objects
    # GDPR: uploads are in the export, and an unfinished one's object goes when the user is erased.
    export = json.loads(zipfile.ZipFile(io.BytesIO((await user.get("/api/me/export")).content)).read("data.json"))
    assert [u["filename"] for u in export["file_uploads"]] == ["halv.bin"]
    start = (await user.post("/api/files/uploads", json={"path": "~/", "filename": "igang.bin", "size": 3})).json()
    await _put(user, start["url"], b"abc")
    assert (await user.post("/api/me/delete", json={"confirm_phone": "22222222"})).status_code == 200
    assert not get_storage().objects
    assert owner_conn.execute("select count(*) from file_uploads").fetchone()[0] == 0
