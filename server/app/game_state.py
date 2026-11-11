
"""
game_state.py

Manages the current Gamefield game state.
Day 1: initialization foundation.
"""

from datetime import datetime, timezone
from threading import RLock
from typing import Any


DEFAULT_DURATION_SECONDS = 300


class GameStateManager:
    def __init__(self) -> None:
        self._lock = RLock()
        self._state: dict[str, Any] = self._initial_state()

    @staticmethod
    def _initial_state() -> dict[str, Any]:
        return {
            "status": "idle",
            "duration_seconds": DEFAULT_DURATION_SECONDS,
            "remaining_seconds": DEFAULT_DURATION_SECONDS,
            "started_at": None,
            "initialized_at": datetime.now(timezone.utc).isoformat(),
        }

    def initialize(
        self,
        duration_seconds: int = DEFAULT_DURATION_SECONDS,
    ) -> dict[str, Any]:
        if isinstance(duration_seconds, bool) or not isinstance(
            duration_seconds, int
        ):
            raise ValueError("duration_seconds must be an integer")

        if duration_seconds <= 0:
            raise ValueError("duration_seconds must be greater than zero")

        with self._lock:
            self._state = self._initial_state()
            self._state["duration_seconds"] = duration_seconds
            self._state["remaining_seconds"] = duration_seconds

            return self.get_state()

    def get_state(self) -> dict[str, Any]:
        with self._lock:
            return self._state.copy()


game_state_manager = GameStateManager()
