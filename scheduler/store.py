"""
SQLite-сховище для mode/scenarios/offline_brightness/brightness ПО
ЗОНАХ/КАНАЛАХ.

ESP тепер має ЛИШЕ стандартний brightness + on/off кластер - жодного
кастомного кластера немає. Тому єдине джерело правди для всього, чим
керує LogicService (включно з РЕЗУЛЬТАТОМ таймерного режиму), - ця
локальна база, а не Zigbee/Z2M.

`brightness` - СПІЛЬНЕ поле для ручного і таймерного режимів: хто б його
не встановив (пряма команда /set чи тіковий розрахунок з scenarios),
записується в те саме поле. GET завжди повертає актуальне значення
незалежно від джерела.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT

DEFAULT_DB_PATH = PROJECT_ROOT / "scheduler_state.sqlite3"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS channel_config (
    zone INTEGER NOT NULL,
    channel INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'manual',
    scenarios TEXT NOT NULL DEFAULT '[]',
    offline_brightness INTEGER NOT NULL DEFAULT 0,
    brightness INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zone, channel)
);
"""

VALID_FIELDS = {"mode", "scenarios", "offline_brightness", "brightness"}


class ChannelStore:
    """Потокобезпечний доступ до локальної бази конфігурації каналів."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        with self._lock:
            self._conn.execute(_SCHEMA)
            self._conn.commit()

    def get(self, zone: int, channel: int) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT mode, scenarios, offline_brightness, brightness "
                "FROM channel_config WHERE zone=? AND channel=?",
                (zone, channel),
            ).fetchone()
        if row is None:
            return {"mode": "manual", "scenarios": [], "offline_brightness": 0, "brightness": 0}
        mode, scenarios_raw, offline_brightness, brightness = row
        try:
            scenarios = json.loads(scenarios_raw)
        except json.JSONDecodeError:
            scenarios = []
        return {
            "mode": mode,
            "scenarios": scenarios,
            "offline_brightness": offline_brightness,
            "brightness": brightness,
        }

    def update(self, zone: int, channel: int, updates: dict[str, Any]) -> dict[str, Any]:
        """Часткове оновлення - приймає лише ключі з VALID_FIELDS, решту ігнорує."""
        current = self.get(zone, channel)
        for key, value in updates.items():
            if key not in VALID_FIELDS:
                continue
            current[key] = value

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO channel_config (zone, channel, mode, scenarios, offline_brightness, brightness)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(zone, channel) DO UPDATE SET
                    mode = excluded.mode,
                    scenarios = excluded.scenarios,
                    offline_brightness = excluded.offline_brightness,
                    brightness = excluded.brightness
                """,
                (
                    zone, channel,
                    current["mode"],
                    json.dumps(current["scenarios"]),
                    int(current["offline_brightness"]),
                    int(current["brightness"]),
                ),
            )
            self._conn.commit()
        return current

    def close(self) -> None:
        self._conn.close()
