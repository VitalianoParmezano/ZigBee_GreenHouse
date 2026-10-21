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
from logging import log
from typing import Any, Optional
from scheduler.store import ChannelStore
import math


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


def resolve_scenario_target_brightness(points: list[ScenarioPoint], now_minutes: int) -> Optional[int]:
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


# ---------------------------------------------------------------------------
# Авторежим: розклад той самий (HH:MM + %), але результат коригується за
# показником датчика (μmol/m²/s, PPFD) через калібрувальний множник
# (umol_multiplier з config.yaml, sensor.umol_multiplier).
# ---------------------------------------------------------------------------

def percent_to_umol(percent: float, umol_multiplier: float) -> float:
    """Відсоток яскравості (0..100) -> μmol/m²/s: percent * umol_multiplier."""
    return percent * umol_multiplier


def umol_to_percent(umol: float, umol_multiplier: float) -> float:
    """Обернена операція: μmol/m²/s -> відсоток яскравості: umol / umol_multiplier."""
    if umol_multiplier == 0:
        return 0.0
    return umol / umol_multiplier

# Система PBD Power balance dynamic коригує цільовий відсоток так щоб 
# значення не перевищувало максимальну потужність лампи у ватах
def PBD_correction():
    return 0

def auto_correction_resolve(percent: int, sensor_lux: float, max_umol: float,) -> Optional[int]:
    """
    Авторежим: базовий відсоток береться з розкладу (той самий алгоритм,
    що й у таймері - resolve_target_brightness), переводиться в μmol за
    калібрувальним множником, і з нього віднімається те, що вже реально
    показує датчик (сонце, сусідні лампи тощо) - різниця конвертується
    назад у відсоток і є тим, що треба доввімкнути штучним світлом.

    Приклад: розклад каже "50%" о цій годині, множник 25.0 -> цільові
    50 * 25 = 1250 μmol. Датчик показує 300 μmol (частково є природне
    світло) -> треба ще (1250 - 300) / 25 = 38% штучного світла, а не
    повні 50%. Якщо датчик уже показує 1250+ μmol - результат обрізається
    до 0 (світла й так достатньо, доввімкнювати нічого не треба).

    Повертає None, якщо розклад порожній (як і resolve_target_brightness).
    """

    sensor_umol = sensor_lux / 69  # Переводимо lux -> μmol/m²/s (PPFD) за емпіричною формулою

    user_percent = max(0, min(100, percent))  # обрізаємо в межі 0..100, якщо хтось там на фронті щось криво ввів
    
    target_umol = user_percent * max_umol / 100  # percent * umol_multiplier

    diff_umol = target_umol - sensor_umol   # diff 

    if diff_umol <= 0:
        return 0

    target_percent = diff_umol / max_umol * 100  # μmol -> percent

    return int(round(target_percent))

# Коментарі це інший спосіб вирішення тієї ж задачі, що й у PBD_correction(), але з більшою деталізацією, додатковим захистом і всім таким. Не видаляти
def pbd_limit(
    targets: dict[int, int],          # {channel: percent} після таймера/авто
    channel_watts: dict[int, float],  # ват на 100%
    max_watts: float,
    yield_channel: Optional[int] = None,
) -> dict[int, int]:
    # def total(t):
    #     return sum(t[ch] / 100 * channel_watts.get(ch, 0.0) for ch in t)
    def watts(ch: int) -> float:
        return targets[ch] / 100 * channel_watts.get(ch, 0.0)

    total_w = sum(watts(ch) for ch in targets)
    if total_w <= max_watts:
        return dict(targets)

    w = channel_watts.get(yield_channel, 0.0)
    if yield_channel not in targets or w <= 0:
        return dict(targets)

    others_w = sum(
        targets[ch] / 100 * channel_watts.get(ch, 0.0)
        for ch in targets if ch != yield_channel
    )
    red_percent = math.floor((max_watts - others_w) / w * 100)

    result = dict(targets)
    result[yield_channel] = max(0, min(targets[yield_channel], red_percent))
    return result

    budget_pct = math.floor((max_watts - others_w) / w * 100)   # скільки % влізе в залишок
    allowed = max(0, min(targets[yield_channel], budget_pct))

    return {**targets, yield_channel: allowed}

    # # Перевірка чи взагалі треба обмежувати
    # result = dict(targets)
    # excess = total(result) - max_watts
    # if excess <= 0:
    #     return result

    # # зрізаємо "поступливий" канал
    # w = channel_watts.get(yield_channel, 0.0) if yield_channel in result else 0.0
    # if w > 0:
    #     cur_w = result[yield_channel] / 100 * w
    #     cut = min(cur_w, excess)
    #     result[yield_channel] = max(0, math.floor((cur_w - cut) / w * 100))
    #     excess = total(result) - max_watts
    #     if excess <= 0:
    #         return result

    # # 2) якщо ще перебір — пропорційно зменшуємо решту
    # others = [ch for ch in result if ch != yield_channel]
    # others_w = sum(result[ch] / 100 * channel_watts.get(ch, 0.0) for ch in others)
    # if others_w > 0:
    #     k = max(0.0, (others_w - excess) / others_w)
    #     for ch in others:
    #         result[ch] = math.floor(result[ch] * k)   # floor, щоб ніколи не перевищити ліміт
    # return result    