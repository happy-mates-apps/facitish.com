"""Getting an MCP token the way a real client does: register, authorize (normal login), consent, token."""

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlparse

REDIRECT = "http://127.0.0.1:33418/callback"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def register(client, name="Claude Code") -> str:
    r = await client.post("/mcp/register", json={"client_name": name, "redirect_uris": [REDIRECT]})
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


async def authorize_code(client, client_id: str, scope: str = "mcp") -> tuple[str, str]:
    """`client` must be logged in (cookie). Returns (code, verifier)."""
    verifier, challenge = pkce()
    query = {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
             "code_challenge_method": "S256", "scope": scope, "state": "xyz"}
    r = await client.get("/mcp/authorize", params=query)
    assert r.status_code == 302 and r.headers["location"].startswith("/forbind?"), r.text
    consent = {k: v for k, v in query.items() if k != "response_type"}
    r = await client.post("/api/mcp/consent", json={**consent, "approve": True})
    assert r.status_code == 200, r.text
    back = parse_qs(urlparse(r.json()["redirect"]).query)
    assert back["state"] == ["xyz"]
    return back["code"][0], verifier


async def exchange(client, client_id: str, code: str, verifier: str):
    return await client.post("/mcp/token", data={"grant_type": "authorization_code", "code": code, "client_id": client_id,
                                                  "redirect_uri": REDIRECT, "code_verifier": verifier})


async def mcp_token(client, scope: str = "mcp") -> dict:
    client_id = await register(client)
    code, verifier = await authorize_code(client, client_id, scope)
    r = await exchange(client, client_id, code, verifier)
    assert r.status_code == 200, r.text
    return {**r.json(), "client_id": client_id}
