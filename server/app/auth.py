"""
auth.py

Password hashing for judge accounts. Kept separate from db.py —
this file knows nothing about the database, just how to turn a
plain password into a hash, and how to check one against it.
"""

from passlib.context import CryptContext
import secrets # python stdlib for generating secure random tokens
from datetime import datetime, timedelta, timezone
from app.db import get_db

SESSION_LIFETIME = timedelta(hours=8) # how long a session is valid for, after which the user must log in again

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def create_session(judge_id: int) -> tuple[str, datetime]:
    session_id = secrets.token_urlsafe(32)    # secrets.token_urlsafe(32) generates a secure random URL-safe token of 32 bytes, which is suitable for use as a session ID.
    expires_at = datetime.now(timezone.utc) + SESSION_LIFETIME

    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO sessions (session_id, judge_id, expires_at) VALUES (%s, %s, %s)",
        (session_id, judge_id, expires_at),
    )
    conn.commit()
    conn.close()

    return session_id, expires_at