"""
db.py

PostgreSQL connection for judge authentication and scoring.
Credentials are loaded from environment variables (via .env, never
committed to git) rather than hardcoded.
"""

import os

import psycopg2 #the driver package itself, what actually speaks Postgres's network protocol.
import psycopg2.extras 
from dotenv import load_dotenv #reads your .env file and copies its contents into os.environ

load_dotenv() # Load environment variables from .env file


def get_db():
    conn = psycopg2.connect(
        host=os.environ["GAMEFIELD_DB_HOST"],
        port=os.environ["GAMEFIELD_DB_PORT"],
        dbname=os.environ["GAMEFIELD_DB_NAME"],
        user=os.environ["GAMEFIELD_DB_USER"],
        password=os.environ["GAMEFIELD_DB_PASSWORD"],
        cursor_factory=psycopg2.extras.RealDictCursor,
    )
    try:
        yield conn  # FastAPI hands this connection to your route/dependency here
    finally:
        conn.close()  # FastAPI automatically runs this when the request finishes!
