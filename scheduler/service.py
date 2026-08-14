"""
Головний цикл: раз на tick_interval_sec секунд проходить по всіх
зонах/каналах і для тих, що в режимі 'timer', рахує цільову яскравість
за scenarios та застосовує її (пише в те саме поле 'brightness', що й
ручне керування, і публікує реальну zigbee-команду), якщо значення
відрізняється від останнього відправленого.

'manual' - нічого не робить у тіку: керування вже відбулось миттєво
в момент /set (див. mqtt_state._handle_set).
'auto'   - TODO: поки що не реалізовано, канал просто пропускається.

Навмисно НЕ event-driven - а періодичний ПЕРЕРАХУНОК З НУЛЯ. Тому
пропущений такт (перезапуск сервера, збій MQTT) нічого не "губить": на
наступному тіку стан однаково підтягнеться до правильного значення.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

from .config import settings
from .mqtt_state import MqttState
from .schedule_logic import next_change, parse_scenarios, resolve_target_brightness

log = logging.getLogger("service")


class SchedulerService:
    def __init__(self) -> None:
        self.state = MqttState()
        # (zone, channel) -> останнє застосоване timer-ом значення, щоб не
        # спамити мережу однаковою командою щотіку, поки нічого не змінилось.
        self._last_sent: dict[tuple[int, int], int] = {}

    def start(self) -> None:
        level = getattr(logging, settings.log_level, logging.INFO)
        logging.basicConfig(
            level=level,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )
        log.info(
            "Старт LogicService (dry_run=%s, tick=%ss, zones=%s x channels=%s, log_level=%s)",
            settings.dry_run, settings.tick_interval_sec, settings.zones,
            settings.channels_per_zone, settings.log_level,
        )
        try:
            self.state.connect()
        except (ConnectionRefusedError, OSError, TimeoutError) as e:
            log.error(
                "Не вдалося підключитись до MQTT-брокера %s:%s -> %s",
                settings.mqtt_host, settings.mqtt_port, e,
            )
            log.error(
                "Перевір: 1) mqtt.host/mqtt.port у config.yaml правильні, "
                "2) брокер справді запущений і слухає цей порт, "
                "3) з машини, де запущено main.py, цей хост/порт взагалі досяжний."
            )
            raise

        log.debug("Пауза 3с - чекаємо на retained-повідомлення від брокера...")
        time.sleep(3)
        try:
            while True:
                self._tick()
                log.debug("Тік завершено, сплю %sс", settings.tick_interval_sec)
                time.sleep(settings.tick_interval_sec)
        except KeyboardInterrupt:
            log.info("Зупинка за Ctrl+C")
        finally:
            self.state.disconnect()

    def _tick(self) -> None:
        now = datetime.now()
        now_minutes = now.hour * 60 + now.minute
        log.debug("=== Тік о %02d:%02d ===", now.hour, now.minute)

        timer_channels = 0
        commands_sent = 0
        for zone in range(1, settings.zones + 1):
            for channel in range(1, settings.channels_per_zone + 1):
                result = self._process_channel(zone, channel, now_minutes)
                if result == "sent":
                    commands_sent += 1
                    timer_channels += 1
                elif result == "unchanged": # Зараз не використовується, але всерівно можна витягнути, можливо у майбутньому знадобиться.
                    commands_sent += 1
                    timer_channels += 1

        log.info(
            "Тік завершено: %s канал(ів) у timer-режимі, %s команд(и) надіслано",
            timer_channels, commands_sent,
        )

    def _process_channel(self, zone: int, channel: int, now_minutes: int) -> str:
        """Повертає 'sent' / 'unchanged' / 'skipped' - для підрахунку в _tick()."""
        label = f"Zone {zone} / Channel {channel}"
        cfg = self.state.get_channel_config(zone, channel)
        mode = cfg["mode"]

        if mode == "manual":
            target = cfg.get("brightness", 0)  # Беремо поточну яскравість з конфігу
            key = (zone, channel)
            
            # Якщо потрібно не спамити однаковими повідомленнями, можна розкоментувати:
            # if self._last_sent.get(key) == target:
            #     log.debug("%s: без змін (manual %s%%)", label, target)
            #     return "unchanged"

            log.info("%s: manual -> %s%% (періодичне оновлення стану)", label, target)
            # Використовуємо існуючий метод для публікації яскравості в MQTT
            self.state.apply_timer_brightness(zone, channel, target) 
            self._last_sent[key] = target
            return "sent"
        
        if mode == "auto":
            # TODO: авторежим (напр. за освітленістю/датчиками) - поки не реалізовано.
            log.debug("%s: пропуск (mode=auto, ще не реалізовано)", label)
            return "skipped"

        if mode != "timer":
            log.debug("%s: пропуск (невідомий mode=%r)", label, mode)
            return "skipped"

        points = parse_scenarios(cfg["scenarios"])
        if not points:
            log.debug("%s: пропуск (mode=timer, але scenarios порожні/некоректні)", label)
            return "skipped"

        target = resolve_target_brightness(points, now_minutes)
        if target is None:
            log.debug("%s: резолюція не дала результату (не мало б статись)", label)
            return "skipped"

        key = (zone, channel)
        # if self._last_sent.get(key) == target:
        #     log.debug("%s: без змін (%s%%)", label, target)
        #     return "unchanged"

        nxt = next_change(points, now_minutes)
        log.info(
            "%s: timer -> %s%% (наступна зміна о %s)",
            label, target, nxt.time_str if nxt else "-",
        )
        self.state.apply_timer_brightness(zone, channel, target)
        self._last_sent[key] = target
        return "sent"
