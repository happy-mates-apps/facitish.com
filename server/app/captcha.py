"""A captcha without a third party: proof of work (the same scheme as ALTCHA).

The server picks a random number n ≤ maxnumber and sends salt, sha256(salt + n) and an HMAC of it. The browser
tries numbers until the hash matches (≈ maxnumber/2 hashes on average, a second or so) and sends the solution back.
Nothing about the visitor is sent anywhere or stored: only the hash of a used challenge, so it works once.

Used by POST /api/auth/otp/start, which both creates accounts and logs in with a one-time code.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time

from app import config

ALGORITHM = "SHA-256"


class CaptchaError(Exception):
    pass


def enabled() -> bool:
    return config.settings.captcha != "off"


def _sign(challenge: str) -> str:
    key = hashlib.sha256(b"gaer-captcha\0" + config.settings.secret_key.encode()).digest()
    return hmac.new(key, challenge.encode(), hashlib.sha256).hexdigest()


def _hash(salt: str, number: int) -> str:
    return hashlib.sha256(f"{salt}{number}".encode()).hexdigest()


def new_challenge() -> dict:
    s = config.settings
    expires = int(time.time()) + s.captcha_ttl_seconds
    salt = f"{secrets.token_hex(12)}?expires={expires}"
    challenge = _hash(salt, secrets.randbelow(s.captcha_max_number + 1))
    return {"algorithm": ALGORITHM, "challenge": challenge, "salt": salt, "maxnumber": s.captcha_max_number,
            "signature": _sign(challenge), "expires": expires}


def solve(challenge: dict) -> str:
    """The client's side, for tests and scripts: returns the payload to send."""
    for number in range(challenge["maxnumber"] + 1):
        if _hash(challenge["salt"], number) == challenge["challenge"]:
            return encode_solution(challenge, number)
    raise CaptchaError("no solution")


def encode_solution(challenge: dict, number: int) -> str:
    data = {k: challenge[k] for k in ("algorithm", "challenge", "salt", "signature")} | {"number": number}
    return base64.b64encode(json.dumps(data).encode()).decode()


async def verify(conn, payload: str | None) -> None:
    """Raises CaptchaError unless the payload solves a challenge we issued, in time, for the first time."""
    if not payload:
        raise CaptchaError("missing")
    try:
        data = json.loads(base64.b64decode(payload, validate=True))
        challenge, salt, signature = str(data["challenge"]), str(data["salt"]), str(data["signature"])
        number = int(data["number"])
    except (ValueError, KeyError, TypeError):
        raise CaptchaError("malformed")
    if data.get("algorithm") != ALGORITHM or not hmac.compare_digest(signature, _sign(challenge)):
        raise CaptchaError("signature")
    try:
        expires = int(salt.rsplit("?expires=", 1)[1])
    except (IndexError, ValueError):
        raise CaptchaError("malformed")
    if expires < time.time():
        raise CaptchaError("expired")
    if not 0 <= number <= config.settings.captcha_max_number or _hash(salt, number) != challenge:
        raise CaptchaError("wrong")
    cur = await conn.execute("""insert into captcha_spent (challenge, expires_at) values (%s, to_timestamp(%s))
                                on conflict do nothing""", (challenge, expires))
    if not cur.rowcount:
        raise CaptchaError("reused")

