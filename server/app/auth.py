"""
auth.py

Password hashing and session creation utilities for judge accounts.
"""

from passlib.context import CryptContext
import secrets  # python stdlib for generating secure random tokens
from datetime import datetime, timedelta, timezone
from app.db import get_db
from typing import Optional
from fastapi import Cookie, HTTPException, Depends

SESSION_LIFETIME = timedelta(hours=8)  # how long a session is valid for

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)

# Explicitly define East Africa Time (UTC+3)
EAT = timezone(timedelta(hours=3))
SESSION_LIFETIME = timedelta(hours=8)

# Explicitly define East Africa Time (UTC+3)
EAT = timezone(timedelta(hours=3))
SESSION_LIFETIME = timedelta(hours=8)

def create_session(judge_id: int, conn) -> tuple[str, datetime]:
    session_id = secrets.token_urlsafe(32)    
    
    # 1. Database Entry: Calculate exactly in EAT and strip tzinfo 
    # to save a clean, local timestamp string for your SQL queries.
    db_expires_at = datetime.now(EAT).replace(tzinfo=None) + SESSION_LIFETIME

    # 2. Browser Cookie: Generate a matching timezone-aware UTC object 
    # so FastAPI can convert it to a valid GMT string without crashing.
    cookie_expires_at = datetime.now(timezone.utc) + SESSION_LIFETIME

    cur = conn.cursor()
    cur.execute(
        "INSERT INTO sessions (session_id, judge_id, expires_at) VALUES (%s, %s, %s)",
        (session_id, judge_id, db_expires_at),
    )
    conn.commit()

    # Return the cookie-compatible UTC timestamp to app/main.py
    return session_id, cookie_expires_at

# Inside app/auth.py

def get_current_judge(
    session_id: Optional[str] = Cookie(default=None),
    conn = Depends(get_db)
):
    if session_id is None:
        raise HTTPException(status_code=401, detail="Not logged in")

    cur = conn.cursor()
    # FIX: Force PostgreSQL to evaluate the expiration rule using East Africa Time (EAT)
    cur.execute(
        "SELECT sessions.judge_id, judges.username, judges.display_name "
        "FROM sessions JOIN judges ON judges.judge_id = sessions.judge_id "
        "WHERE sessions.session_id = %s "
        "AND sessions.expires_at > TIMEZONE('Africa/Nairobi', NOW())",
        (session_id,),
    )
    judge = cur.fetchone()

    if judge is None:
        raise HTTPException(status_code=401, detail="Session invalid or expired")

    return judge

