"""The file tree: homes under /users/<id>/ and /shared/ (app/filetree.py) — the user API, /api/admin/files,
the MCP tools and GDPR."""

import io
import json
import zipfile

from tests.helpers import full_user, otp_login
from tests.mcp_helpers import mcp_token
from tests.mcp_client import McpClient


async def _ids(admin, user) -> tuple[int, int]:
    return ((await admin.get("/api/auth/me")).json()["user"]["id"], (await user.get("/api/auth/me")).json()["user"]["id"])


async def _two(make_client):
    admin, user = make_client(), make_client()
    await full_user(admin, "11111111")
    await otp_login(user, "22222222")
    return admin, user


def _actions(owner_conn) -> list[str]:
    return [r[0] for r in owner_conn.execute("select action from audit_log order by id").fetchall()]


async def test_user_home_and_shared(make_client, owner_conn):
    admin, user = await _two(make_client)
    admin_id, user_id = await _ids(admin, user)

    r = await user.post("/api/files?path=~/noter/", files={"file": ("a.txt", b"hej", "text/plain")})
    assert r.status_code == 200 and r.json()["path"] == f"/users/{user_id}/noter/a.txt"
    # The same name again gets a free name.
    r = await user.post("/api/files?path=~/noter/", files={"file": ("a.txt", b"igen", "text/plain")})
    assert r.json()["filename"] == "a (2).txt"

    home = (await user.get("/api/files/tree")).json()
    assert home["path"] == f"/users/{user_id}/" and [f["name"] for f in home["folders"]] == ["noter"]
    assert home["folders"][0]["files"] == 2
    root = (await user.get("/api/files/tree?path=/users/")).json()
    assert [f["user_id"] for f in root["folders"]] == [user_id]  # a user only sees their own home
    assert (await user.get(f"/api/files/tree?path=/users/{admin_id}/")).status_code == 404
    assert (await user.get("/api/files/tree?path=/shared/../users/")).status_code == 400

    # /shared: the user writes, the admin reads and may overwrite; only the uploader (or an admin) deletes.
    r = await user.put("/api/files/text", json={"path": "/shared/projekt/brief.md", "content": "# Brief"})
    assert r.status_code == 200, r.text
    shared = r.json()
    assert shared["path"] == "/shared/projekt/brief.md" and shared["user_id"] is None
    assert shared["content_type"] == "text/markdown" and shared["preview"] == "text"
    got = (await admin.get("/api/files/by-path?path=/shared/projekt/brief.md")).json()
    assert got["text"] == "# Brief"
    r = await admin.put("/api/files/text", json={"path": "/shared/projekt/brief.md", "content": "# Brief v2"})
    assert r.json()["id"] == shared["id"]
    assert (await user.get(f"/api/files/{shared['id']}")).json()["text"] == "# Brief v2"
    assert (await admin.delete(f"/api/files/{shared['id']}")).status_code == 403
    assert (await admin.patch(f"/api/files/{shared['id']}", json={"filename": "x.md"})).status_code == 403
    # A shared folder with files cannot be deleted by a user.
    assert (await user.delete("/api/files/folders?path=/shared/projekt/")).status_code == 403

    # Move a file from the home to /shared and back.
    own = (await user.get("/api/files")).json()
    first = next(f for f in own if f["filename"] == "a.txt")
    r = await user.patch(f"/api/files/{first['id']}", json={"folder": "/shared/projekt/"})
    assert r.status_code == 200 and r.json()["path"] == "/shared/projekt/a.txt"
    r = await user.patch(f"/api/files/{first['id']}", json={"folder": f"/users/{admin_id}/"})
    assert r.status_code == 404  # never into someone else's home
    assert (await user.delete(f"/api/files/{first['id']}")).status_code == 200

    link = (await admin.get(f"/api/files/{shared['id']}/link")).json()
    assert (await admin.get(link["url"])).content == b"# Brief v2"

    actions = _actions(owner_conn)
    for a in ("file.upload", "file.write", "file.move", "file.delete"):
        assert a in actions, a


async def test_admin_tree_preview_and_folders(make_client, owner_conn):
    admin, user = await _two(make_client)
    _, user_id = await _ids(admin, user)
    await user.post("/api/files", files={"file": ("mine.txt", b"brugerens", "text/plain")})

    root = (await admin.get("/api/admin/files/tree")).json()
    assert [f["name"] for f in root["folders"]] == ["users", "shared"]
    assert root["totals"]["home_files"] == 1
    users = (await admin.get("/api/admin/files/tree?path=/users/")).json()
    assert {f["user_id"] for f in users["folders"]} >= {user_id}
    assert users["can_write"] is False

    r = await admin.post("/api/admin/files/folders", json={"path": "/shared/tom/mappe/"})
    assert r.status_code == 200 and r.json()["created"]
    shared = (await admin.get("/api/admin/files/tree?path=/shared/")).json()
    assert [f["name"] for f in shared["folders"]] == ["tom"]
    assert (await admin.get("/api/admin/files/tree?path=/shared/tom/")).json()["folders"][0]["path"] == "/shared/tom/mappe/"

    png = b"\x89PNG\r\n\x1a\n" + b"0" * 20
    r = await admin.post(f"/api/admin/files/upload?path=/users/{user_id}/billeder/", files={"file": ("x.png", png, "image/png")})
    assert r.status_code == 200, r.text
    img = r.json()
    assert img["path"] == f"/users/{user_id}/billeder/x.png" and img["preview"] == "image"
    raw = await admin.get(f"/api/admin/files/item/{img['id']}/raw")
    assert raw.content == png and "sandbox" in raw.headers["content-security-policy"]
    assert raw.headers["content-disposition"].startswith("inline")

    html = (await admin.post("/api/admin/files/upload?path=/shared/", files={"file": ("x.html", b"<script>1</script>", "text/html")})).json()
    raw = await admin.get(f"/api/admin/files/item/{html['id']}/raw")
    assert raw.headers["content-type"].startswith("text/plain") and "sandbox" in raw.headers["content-security-policy"]
    item = (await admin.get(f"/api/admin/files/item/{html['id']}")).json()
    assert item["text"] == "<script>1</script>"

    # Move the user's image into /shared: it follows the folder.
    r = await admin.patch(f"/api/admin/files/item/{img['id']}", json={"folder": "/shared/tom/", "filename": "y.png"})
    assert r.status_code == 200 and r.json()["path"] == "/shared/tom/y.png" and r.json()["user_id"] is None
    assert (await user.get(f"/api/files/{img['id']}")).json()["path"] == "/shared/tom/y.png"

    r = await admin.delete("/api/admin/files/folders?path=/shared/tom/")
    assert r.status_code == 200 and r.json()["files"] == 1 and r.json()["folders"] == 2
    assert (await admin.get("/api/admin/files/tree?path=/shared/tom/")).status_code == 404
    assert (await admin.get(f"/api/admin/files/item/{img['id']}")).status_code == 404
    assert (await admin.delete("/api/admin/files/folders?path=/shared/")).status_code == 400

    # Not for users.
    assert (await user.get("/api/admin/files/tree")).status_code == 403
    actions = _actions(owner_conn)
    assert "file.folder_create" in actions and "file.folder_delete" in actions and "file.move" in actions


async def _mcp(http, scope="mcp") -> McpClient:
    t = await mcp_token(http, scope)
    return await McpClient(http, "/mcp/admin" if scope == "mcp:admin" else "/mcp", t["access_token"]).initialize()


async def test_mcp_file_tools(make_client, owner_conn):
    admin, user = await _two(make_client)
    admin_id, user_id = await _ids(admin, user)
    await admin.put("/api/files/text", json={"path": "~/hemmelig.md", "content": "kun admin"})

    m = await _mcp(user)
    made, err = await m.call("folder_create", path="/shared/nord/")
    assert not err and made["path"] == "/shared/nord/"
    wrote, err = await m.call("file_write", path="/shared/nord/referat.md", content="# Uge 45")
    assert not err and wrote["file"]["path"] == "/shared/nord/referat.md"
    read, err = await m.call("file_read", path="/shared/nord/referat.md")
    assert not err and read["text"] == "# Uge 45"
    listing, err = await m.call("files_browse", path="/shared/nord/")
    assert not err and [f["filename"] for f in listing["files"]] == ["referat.md"]
    home, _ = await m.call("files_browse")
    assert home["path"] == f"/users/{user_id}/"
    _, err = await m.call("file_read", path=f"/users/{admin_id}/hemmelig.md")
    assert err
    moved, err = await m.call("file_move", path="/shared/nord/referat.md", toFolder="~/", newName="r.md")
    assert not err and moved["file"]["path"] == f"/users/{user_id}/r.md"
    d, err = await m.call("file_delete", path="~/r.md")
    assert not err and d["draftId"]
    assert owner_conn.execute("select count(*) from files where filename = 'r.md'").fetchone()[0] == 1
    done, err = await m.call("confirm_draft", draftId=d["draftId"], reason="ryd op")
    assert not err
    assert owner_conn.execute("select count(*) from files where filename = 'r.md'").fetchone()[0] == 0

    a = await _mcp(admin, "mcp:admin")
    tree, err = await a.call("files_browse", path="/users/")
    assert not err and {f["user_id"] for f in tree["folders"]} == {admin_id, user_id}
    d, err = await a.call("file_write", path=f"/users/{user_id}/fra-admin.md", content="hej")
    assert not err and "fra-admin.md" in d["summary"]
    assert owner_conn.execute("select count(*) from files where filename = 'fra-admin.md'").fetchone()[0] == 0
    done, err = await a.call("confirm_draft", draftId=d["draftId"], reason="aftalt med brugeren")
    assert not err and done["result"]["file"]["user_id"] == user_id
    read, _ = await a.call("file_read", path=f"/users/{admin_id}/hemmelig.md")
    assert read["text"] == "kun admin"
    link, err = await a.call("file_link", path=f"/users/{user_id}/fra-admin.md")
    assert not err and link["download_url"]
    d, err = await a.call("folder_delete", path="/shared/nord/")
    assert not err and d["impact"]["counts"]["folders"] == 1
    await a.call("confirm_draft", draftId=d["draftId"], reason="tom mappe")
    assert owner_conn.execute("select count(*) from file_folders where path = '/nord/'").fetchone()[0] == 0
    actions = set(_actions(owner_conn))
    assert {"mcp.file_write", "mcp.folder_delete", "mcp.file_delete"} <= actions


async def test_gdpr_export_and_erasure(make_client, owner_conn):
    admin, user = await _two(make_client)
    _, user_id = await _ids(admin, user)
    await user.post("/api/files?path=~/a/", files={"file": ("mine.txt", b"x", "text/plain")})
    shared = (await user.put("/api/files/text", json={"path": "/shared/p/fælles.md", "content": "y"})).json()

    z = zipfile.ZipFile(io.BytesIO((await user.get("/api/me/export")).content))
    data = json.loads(z.read("data.json"))
    assert data["files"][0]["folder"] == "/a/"
    assert [f["path"] for f in data["shared_files"]] == ["/shared/p/fælles.md"]

    r = await user.post("/api/me/delete", json={"confirm_phone": "22222222"})
    assert r.status_code == 200 and r.json()["files"] == 1
    assert owner_conn.execute("select count(*) from file_folders where user_id = %s", (user_id,)).fetchone()[0] == 0
    row = owner_conn.execute("select uploaded_by from files where id = %s", (shared["id"],)).fetchone()
    assert row == (None,)
