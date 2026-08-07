"""
Чиста логіка "яка яскравість має діяти зараз" на основі масиву scenarios
у форматі [{"time": "HH:MM", "brightness": 0..100}, ...] — тому самому,
що зберігає greenhouse-zone-card.js (_attachTimerListeners) і кодує
greenhouse_grouper.js (encodeScenarios) у бінарний кластер на пристрої.

Тут навмисно немає жодного MQTT чи побічних ефектів — це саме той
алгоритм, який або (а) виконує сама ESP32 локально, маючи власний
device_time, або (б) виконує сервер, якщо рішено тримати розклад-логіку
поза пристроєм. Винесення в чистий модуль дозволяє юніт-тестувати його
без брокера й без заліза.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class ScenarioPoint:
    minutes: int      # хвилина доби, 0..1439 (00:00..23:59)
    brightness: int   # 0..100

    @property
    def time_str(self) -> str:
        return f"{self.minutes // 60:02d}:{self.minutes % 60:02d}"


def _time_to_minutes(time_str: str) -> int:
    h, m = time_str.split(":")
    return int(h) * 60 + int(m)


def parse_scenarios(raw: Optional[list[dict[str, Any]]]) -> list[ScenarioPoint]:
    """Парсить сирий JSON-масив у відсортований за часом список ScenarioPoint.
    Некоректні або порожні записи мовчки пропускаються (як і в
    _attachTimerListeners на фронті — порожній час = рядок ігнорується)."""
    if not raw:
        return []

    points: list[ScenarioPoint] = []
    for item in raw:
        t = item.get("time")
        b = item.get("brightness")
        if not t or b is None:
            continue
        try:
            minutes = _time_to_minutes(str(t))
        except (ValueError, AttributeError):
            continue
        brightness = max(0, min(100, int(b)))
        points.append(ScenarioPoint(minutes=minutes, brightness=brightness))

    return sorted(points, key=lambda p: p.minutes)


def resolve_target_brightness(points: list[ScenarioPoint], now_minutes: int) -> Optional[int]:
    """
    Знаходить яскравість, яка має діяти ЗАРАЗ.

    Правило: береться ОСТАННЯ мітка, час якої <= now_minutes (тобто вже
    настала сьогодні). Якщо жодна ще не настала (зараз раніше, ніж перша
    мітка доби) — діє ОСТАННЯ мітка з учорашнього списку: розклад
    циклічний по добі, і освітлення не повинно "скидатись" рівно опівночі,
    якщо останній запис дня був, наприклад, о 23:00.

    Повертає None, якщо коректних міток узагалі немає.
    """
    if not points:
        return None

    active: Optional[ScenarioPoint] = None
    for p in points:
        if p.minutes <= now_minutes:
            active = p
        else:
            break

    if active is None:
        active = points[-1]  # ще не настала жодна мітка сьогодні -> вчорашня остання

    return active.brightness


def next_change(points: list[ScenarioPoint], now_minutes: int) -> Optional[ScenarioPoint]:
    """Допоміжна функція для логів/дебагу: коли наступна запланована зміна."""
    for p in points:
        if p.minutes > now_minutes:
            return p
    return points[0] if points else None
