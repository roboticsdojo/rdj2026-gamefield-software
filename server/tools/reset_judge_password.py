
from getpass import getpass

from app.auth import hash_password
from app.db import get_db


def main():
    username = input("Judge username: ").strip()
    password = getpass("New judge password: ")
    confirm = getpass("Confirm new password: ")

    if not username or not password:
        raise SystemExit("Username and password are required.")

    if password != confirm:
        raise SystemExit("Passwords do not match. No changes made.")

    if len(password) < 12:
        raise SystemExit("Use a password of at least 12 characters.")

    conn = get_db()

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT judge_id
                FROM judges
                WHERE username = %s
                """,
                (username,),
            )
            judge = cur.fetchone()

            if judge is None:
                raise SystemExit(
                    f"No judge found with username {username!r}."
                )

            password_hash = hash_password(password)

            cur.execute(
                """
                UPDATE judges
                SET password_hash = %s
                WHERE judge_id = %s
                """,
                (password_hash, judge["judge_id"]),
            )

            if cur.rowcount != 1:
                conn.rollback()
                raise RuntimeError(
                    "Expected exactly one updated judge. Rolled back."
                )

        conn.commit()
        print("Judge password updated successfully.")

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


if __name__ == "__main__":
    main()
