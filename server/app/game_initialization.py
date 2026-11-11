
"""
game_initialization.py

Database operations required when initializing a Gamefield game.
"""

from psycopg2.extensions import connection


def clear_test_runs(conn: connection) -> int:
    """
    Delete test runs and their dependent records.

    Official competition runs are preserved because is_test defaults
    to FALSE.

    Returns:
        Number of test runs deleted.
    """
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                DELETE FROM runs
                WHERE is_test = TRUE;
                """
            )

            deleted_runs = cursor.rowcount

        conn.commit()
        return deleted_runs

    except Exception:
        conn.rollback()
        raise
