"""The license key from happymates.ai (app/license.py): a JWT checked on the server, statement in every /w <head>."""

import base64
import dataclasses
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app import config
from app import license as lic

PRIVATE = Ed25519PrivateKey.generate()
KID = "test-1"
KEYS = {KID: base64.urlsafe_b64encode(PRIVATE.public_key().public_bytes_raw()).rstrip(b"=").decode()}


def b64(data: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()


def token(header: dict | None = None, key=PRIVATE, **overrides) -> str:
    now = int(time.time())
    claims = {"iss": lic.ISSUER, "prd": "gaer", "jti": "HM-2026-0001", "iat": now, "nbf": now, "exp": now + 3600,
              "domains": ["app.kunde.dk", "*.kunde.net"], "lic": {"name": "Kunde ApS", "cvr": "12345678"}}
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    signing_input = f"{b64(header or {'alg': 'EdDSA', 'typ': 'JWT', 'kid': KID})}.{b64(claims)}"
    sig = base64.urlsafe_b64encode(key.sign(signing_input.encode())).rstrip(b"=").decode()
    return f"{signing_input}.{sig}"


def check(t: str, host: str = "app.kunde.dk", **kw) -> lic.License:
    return lic.verify(t, host=host, keys=KEYS, **kw)


def test_a_valid_key_names_license_licensee_and_domains():
    result = check(token())
    assert result.valid and result.license_id == "HM-2026-0001" and result.licensee == "Kunde ApS"
    assert result.domains == ("app.kunde.dk", "*.kunde.net")
    assert "HM-2026-0001" in lic.statement(result) and "Kunde ApS (CVR 12345678)" in lic.statement(result)


def test_domains_array_decides_where_the_key_works():
    t = token()
    assert check(t, "APP.kunde.dk").valid
    assert check(t, "www.kunde.net").valid and check(t, "a.b.kunde.net").valid
    assert check(t, "kunde.net").status == "wrong_host"  # *.kunde.net is subdomains only
    assert check(t, "evil.dk").status == "wrong_host"
    assert check(token(domains=None)).status == "invalid"
    assert check(token(domains="app.kunde.dk")).status == "invalid"  # must be an array
    assert check(token(domains=[])).status == "invalid"


def test_forged_or_foreign_keys_are_rejected():
    t = token()
    head, body, sig = t.split(".")
    claims = json.loads(base64.urlsafe_b64decode(body + "=="))
    claims["domains"] = ["evil.dk"]
    assert check(f"{head}.{b64(claims)}.{sig}", "evil.dk").status == "invalid"  # tampered claims
    assert check(token(key=Ed25519PrivateKey.generate())).status == "invalid"  # not signed by happymates.ai
    assert check(token(header={"alg": "EdDSA", "kid": "other"})).status == "invalid"
    assert check(token(header={"alg": "none", "kid": KID})).status == "invalid"
    assert check(token(header={"alg": "HS256", "kid": KID})).status == "invalid"
    assert check(token(iss="https://evil.example")).status == "invalid"
    assert check(token(prd="other")).status == "invalid"
    assert check("not-a-jwt").status == "invalid"
    assert check("").status == "missing"
    assert lic.verify(token(), host="app.kunde.dk").status == "invalid"  # no keys configured: nothing is valid


def test_time_window():
    now = int(time.time())
    assert check(token(exp=now - 3600)).status == "expired"
    assert check(token(exp=None)).status == "invalid"
    assert check(token(nbf=now + 3600)).status == "not_yet_valid"


def test_statement_from_the_key_is_used_verbatim_and_escaped():
    result = check(token(stmt='Licenseret til <Kunde> -- "A/S"'))
    block = lic.head_html(result)
    assert "&lt;Kunde&gt;" in block and "<Kunde>" not in block and "-->" == block.split("\n")[0][-3:]
    assert block.split("\n")[0].count("--") == 2  # the comment holds only its own delimiters
    assert '<meta name="license" content="HM-2026-0001">' in block
    assert '<link rel="license" href="https://happymates.ai/licenses/HM-2026-0001">' in block


@pytest.fixture
def licensed(monkeypatch):
    def use(t: str | None, origin: str = "https://app.kunde.dk"):
        monkeypatch.setattr(lic, "ISSUER_KEYS", KEYS)
        monkeypatch.setattr(lic, "_cache", None)
        monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, license_key=t, origin=origin))
    return use


async def test_w_pages_carry_the_statement_in_head(client, licensed):
    licensed(token())
    r = await client.get("/w/", headers={"host": "app.kunde.dk"})
    head = r.text.split("<head>", 1)[1].split("</head>", 1)[0]
    assert '<meta name="license" content="HM-2026-0001">' in head
    assert '<meta name="license-status" content="valid">' in head
    assert r.headers["gaer-license"] == "HM-2026-0001; status=valid"
    assert int(r.headers["content-length"]) == len(r.content)
    assert "Content-Security-Policy" in r.headers

    missing = await client.get("/w/findes-ikke", headers={"host": "app.kunde.dk"})
    assert missing.status_code == 404 and 'content="HM-2026-0001"' in missing.text

    # Served on a domain the key does not list.
    other = await client.get("/w/", headers={"host": "kopi.example"})
    assert '<meta name="license" content="UNLICENSED">' in other.text
    assert '<meta name="license-status" content="wrong_host">' in other.text

    # Only /w is touched.
    assert "gaer-license" not in (await client.get("/w/static/w.css")).headers
    assert "gaer-license" not in (await client.get("/api/public/config")).headers


async def test_without_a_valid_key_w_says_unlicensed(client, licensed):
    licensed(None)
    r = await client.get("/w/")
    assert r.status_code == 200
    assert '<meta name="license" content="UNLICENSED">' in r.text and "UGYLDIG LICENS (missing)" in r.text
    health = (await client.get("/health")).json()
    assert health["license"]["status"] == "missing"

    licensed(token(), origin="https://app.kunde.dk")
    assert (await client.get("/health")).json()["license"] == {
        "status": "valid", "id": "HM-2026-0001", "expires_at": lic.current().expires_at,
        "domains": ["app.kunde.dk", "*.kunde.net"]}


def test_cli_issue_and_verify(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert lic.main(["keygen", "--kid", "hm-test", "--out", "k.pem"]) == 0
    out = capsys.readouterr().out
    public = out.split('"hm-test": "')[1].split('"')[0]
    monkeypatch.setattr(lic, "ISSUER_KEYS", {"hm-test": public})
    assert lic.main(["issue", "--key", "k.pem", "--kid", "hm-test", "--id", "HM-1", "--name", "Kunde ApS",
                     "--domain", "app.kunde.dk", "--domain", "www.kunde.dk"]) == 0
    jwt = capsys.readouterr().out.strip()
    result = lic.verify(jwt, host="www.kunde.dk")
    assert result.valid and result.domains == ("app.kunde.dk", "www.kunde.dk")
    assert lic.main(["verify", jwt, "--host", "evil.dk"]) == 1
