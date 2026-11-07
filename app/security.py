from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any


class InvalidAccessToken(ValueError):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64url(value: str) -> bytes:
    if not value or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for ch in value):
        raise InvalidAccessToken("Malformed access token")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_access_token(username: str, secret: str, ttl_minutes: int, now: int | None = None) -> str:
    if len(secret.encode("utf-8")) < 32:
        raise ValueError("APP_AUTH_SECRET must contain at least 32 bytes")
    issued_at = int(time.time() if now is None else now)
    payload = {
        "v": 1,
        "sub": username,
        "iat": issued_at,
        "exp": issued_at + int(ttl_minutes) * 60,
        "jti": secrets.token_urlsafe(16),
    }
    body = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64url(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify_access_token(
    token: str,
    *,
    username: str,
    secret: str,
    max_ttl_minutes: int,
    now: int | None = None,
) -> dict[str, Any]:
    if len(secret.encode("utf-8")) < 32:
        raise InvalidAccessToken("Authentication is not configured securely")
    try:
        body, supplied_signature = token.split(".", 1)
        expected = _b64url(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied_signature, expected):
            raise InvalidAccessToken("Invalid access token")
        payload = json.loads(_unb64url(body))
        current = int(time.time() if now is None else now)
        issued = int(payload["iat"])
        expires = int(payload["exp"])
        if payload.get("v") != 1 or payload.get("sub") != username:
            raise InvalidAccessToken("Invalid access token")
        if not isinstance(payload.get("jti"), str) or len(payload["jti"]) < 16:
            raise InvalidAccessToken("Invalid access token")
        if issued > current + 60 or expires <= current or expires <= issued:
            raise InvalidAccessToken("Access token expired or invalid")
        if expires - issued > max_ttl_minutes * 60:
            raise InvalidAccessToken("Access token lifetime is invalid")
        return payload
    except InvalidAccessToken:
        raise
    except Exception as exc:
        raise InvalidAccessToken("Malformed access token") from exc
