"""
Auth routes — register, login, me.

DESIGN:
  - Passwords: PBKDF2-HMAC-SHA256 (stdlib), 200k iterations, per-user salt.
    Stored as "salt_hex$hash_hex". No external crypto dependency needed.
  - Sessions: stateless HMAC-signed tokens "base64(email|expiry).signature".
    The server keeps no session table — any API replica can validate a token
    with just the shared SECRET_KEY (same stateless-web-tier principle as jobs).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.database import get_db
from db.models import User

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

_PBKDF2_ITERATIONS = 200_000


# ── PASSWORD HASHING ─────────────────────────────────────

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split("$", 1)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), _PBKDF2_ITERATIONS)
    return hmac.compare_digest(digest.hex(), hash_hex)


# ── TOKENS ───────────────────────────────────────────────

def _sign(payload: str) -> str:
    return hmac.new(settings.secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def create_token(email: str) -> str:
    expires = int(time.time()) + settings.token_ttl_days * 86_400
    payload = f"{email}|{expires}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{encoded}.{_sign(payload)}"


def decode_token(token: str) -> str | None:
    """Return the email if the token is valid and unexpired, else None."""
    try:
        encoded, signature = token.rsplit(".", 1)
        payload = base64.urlsafe_b64decode(encoded.encode()).decode()
    except Exception:
        return None
    if not hmac.compare_digest(_sign(payload), signature):
        return None
    email, _, expires = payload.partition("|")
    if not expires.isdigit() or int(expires) < time.time():
        return None
    return email


async def get_current_user(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Dependency for routes that require a signed-in user."""
    token = authorization.removeprefix("Bearer ").strip()
    email = decode_token(token) if token else None
    if not email:
        raise HTTPException(status_code=401, detail="Not signed in.")
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Account no longer exists.")
    return user


# ── SCHEMAS ──────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    token: str
    name: str
    email: str


# ── ENDPOINTS ────────────────────────────────────────────

@router.post("/register", response_model=AuthResponse, status_code=201)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    email = body.email.lower().strip()
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="An account with this email already exists. Sign in instead.")

    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    db.add(user)
    await db.commit()

    return AuthResponse(token=create_token(email), name=user.name, email=email)


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    email = body.email.lower().strip()
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")

    return AuthResponse(token=create_token(email), name=user.name, email=email)


@router.get("/me", response_model=AuthResponse)
async def me(user: User = Depends(get_current_user)):
    """Validate a stored token and refresh the user's display info."""
    return AuthResponse(token=create_token(user.email), name=user.name, email=user.email)
