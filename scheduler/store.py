"""
SQLite-сховище для mode/scenarios/offline_brightness/brightness
ПО ЗОНАХ/КАНАЛАХ.

ESP тепер має ЛИШЕ стандартний brightness + on/off кластер - жодного
кастомного кластера немає. Тому єдине джерело правди для всього, чим
керує LogicService (включно з РЕЗУЛЬТАТОМ таймерного й авторежиму), - ця
локальна база, а не Zigbee/Z2M.

`brightness` - СПІЛЬНЕ поле для ручного, таймерного і авто режимів: хто б
його не встановив (пряма команда /set чи тіковий розрахунок), записується
в те саме поле. GET завжди повертає актуальне значення незалежно від
джерела.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from .config import PROJECT_ROOT, settings
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

_SCHEMA_LAMPS = """
CREATE TABLE IF NOT EXISTS lamp_config (
    channel INTEGER PRIMARY KEY,
    max_umol REAL NOT NULL DEFAULT 0.0
);
"""

class ChannelStore:
    """Потокобезпечний доступ до локальної бази конфігурації каналів."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        with self._lock:
            self._conn.execute(_SCHEMA)
            self._conn.commit()
            self._conn.execute(_SCHEMA_LAMPS)
            self._conn.commit()


            for ch in range(1, settings.channels_per_zone + 1):  
                self._conn.execute(
                    "INSERT OR IGNORE INTO lamp_config (channel, max_umol) VALUES (?, ?)",
                    (ch, 0.0),
                )
            self._conn.commit()

    def get(self, zone: int, channel: int) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT mode, scenarios, offline_brightness, brightness "
                "FROM channel_config WHERE zone=? AND channel=?",
                (zone, channel),
            ).fetchone()
        if row is None:
            return {
                "mode": "manual", "scenarios": [], 
                "offline_brightness": 0, "brightness": 0,
            }
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
                INSERT INTO channel_config
                    (zone, channel, mode, scenarios, offline_brightness, brightness)
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

    def get_lamp_max_umol(self, channel: int) -> float:
        """Отримує максимальні мікромолі для конкретного каналу"""
        with self._lock:
            row = self._conn.execute(
                "SELECT max_umol FROM lamp_config WHERE channel=?", (channel,)
            ).fetchone()
            return float(row[0]) if row else 200.0

    def update_lamp_max_umol(self, channel: int, max_umol: float) -> None:
        """Оновлює налаштування лампи"""
        with self._lock:
            self._conn.execute(
                "UPDATE lamp_config SET max_umol=? WHERE channel=?", 
                (float(max_umol), channel)
            )
            self._conn.commit()

    def update_all_lamp_max_umols(self, max_umols: dict[int, float]) -> None:
        """Оновлює налаштування всіх ламп за один запит. max_umols - {channel: max_umol}"""
        with self._lock:
            for channel, max_umol in max_umols.items():
                self._conn.execute(
                    "UPDATE lamp_config SET max_umol=? WHERE channel=?", 
                    (float(max_umol), channel)
                )
            self._conn.commit()

    def get_all_lamp_max_umols(self) -> dict[int, float]:
            """Отримує налаштування всіх ламп за один запит. Повертає {channel: max_umol}"""
            with self._lock:
                rows = self._conn.execute("SELECT channel, max_umol FROM lamp_config").fetchall()
                
                # Динамічно генеруємо словник для n каналів з дефолтним значенням 0.0
                # Наприклад: {1: 0.0, 2: 0.0, 3: 0.0, ... n: 0.0}
                result = {ch: 0.0 for ch in range(1, settings.channels_per_zone + 1)}
                
                # Перезаписуємо дефолтні нулі реальними даними з БД
                for ch, val in rows:
                    result[ch] = float(val)
                    
                return result
            
    def close(self) -> None:
        self._conn.close()
