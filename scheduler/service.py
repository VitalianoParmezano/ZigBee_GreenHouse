"""
Головний цикл: раз на tick_interval_sec секунд проходить по всіх
зонах/каналах і для тих, що в режимі 'timer', рахує цільову яскравість
за scenarios та застосовує її (пише в те саме поле 'brightness', що й
ручне керування, і публікує реальну zigbee-команду), якщо значення
відрізняється від останнього відправленого.

'manual' - нічого не робить у тіку: керування вже відбулось миттєво
в момент /set (див. mqtt_state._handle_set).
'auto'   - той самий розклад (HH:MM + %), що й timer, але базовий відсоток
корегується показником датчика (LogicService/bridge/sensor, {"umol": ...})


Навмисно НЕ event-driven - а періодичний ПЕРЕРАХУНОК З НУЛЯ. Тому
пропущений такт (перезапуск сервера, збій MQTT) нічого не "губить": на
наступному тіку стан однаково підтягнеться до правильного значення.
"""
from __future__ import annotations

from ast import Store
import logging
import time
import scheduler.store as store
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .config import PROJECT_ROOT, settings
from .mqtt_state import MqttState
from .schedule_logic import next_change, parse_scenarios, resolve_auto_brightness, resolve_target_brightness

log = logging.getLogger("service")


class SchedulerService:
    def __init__(self) -> None:
        self.state = MqttState()
        self.store = store.ChannelStore()
        # (zone, channel) -> останнє застосоване timer-ом значення, щоб не
        # спамити мережу однаковою командою щотіку, поки нічого не змінилось.
        self._last_sent: dict[tuple[int, int], int] = {}

    def start(self) -> None:
        level = getattr(logging, settings.log_level, logging.INFO)
        formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

        # Консоль - завжди (docker compose logs / journalctl це й ловлять).
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)

        # Файл з ротацією по днях: рівно settings.log_retention_days бекапів +
        # поточний файл = розмір папки НІКОЛИ не росте необмежено, старе саме
        # видаляється (TimedRotatingFileHandler робить це автоматично при
        # кожній півночі, без окремого крон-завдання чи cleanup-скрипта).
        log_dir = PROJECT_ROOT / settings.log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = TimedRotatingFileHandler(
            log_dir / "logicservice.log",
            when="midnight",
            interval=1,
            backupCount=settings.log_retention_days,
            encoding="utf-8",
        )
        file_handler.suffix = "%Y-%m-%d"
        file_handler.setFormatter(formatter)

        logging.basicConfig(level=level, handlers=[console_handler, file_handler], force=True)

        log.info(
            "Старт LogicService (dry_run=%s, tick=%ss, zones=%s x channels=%s, "
            "log_level=%s, log_dir=%s, retention=%sд)",
            settings.dry_run, settings.tick_interval_sec, settings.zones,
            settings.channels_per_zone, settings.log_level, log_dir, settings.log_retention_days,
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

        max_umol = self.state.store.get_all_lamp_max_umols()
        print(f"Max umol per channel: {max_umol}")

        for zone in range(1, settings.zones + 1):
            for channel in range(1, settings.channels_per_zone + 1):
                channel_max_umol = max_umol.get(channel, 0.0)  # дефолтне значення, якщо не знайдено
                result = self._process_channel(zone, channel, now_minutes, max_umol=channel_max_umol)
                if result == "sent":
                    commands_sent += 1
                    timer_channels += 1
                elif result == "unchanged":
                    timer_channels += 1

        if commands_sent > 0:
            log.info(
                "Тік завершено: %s канал(ів) у timer-режимі, %s команд(и) надіслано",
                timer_channels, commands_sent,
            )
        else:
            log.debug(
                "Тік завершено: %s канал(ів) у timer-режимі, змін немає",
                timer_channels,
            )

    def _process_channel(self, zone: int, channel: int, now_minutes: int, max_umol: float) -> str:
        """Повертає 'sent' / 'unchanged' / 'skipped' - для підрахунку в _tick()."""
        label = f"Zone {zone} / Channel {channel}"
        cfg = self.state.get_channel_config(zone, channel)
        mode = cfg["mode"]

        if mode == "manual":
            log.debug("%s: пропуск (mode=manual, керування відбувається одразу через /set)", label)
            return "skipped"

        if mode == "auto":
            points = parse_scenarios(cfg["scenarios"])
            if not points:
                log.debug("%s: пропуск (mode=auto, але scenarios порожні/некоректні)", label)
                return "skipped"

            sensor_umol = self.state.get_sensor_umol()

            target = resolve_auto_brightness(points, now_minutes, sensor_umol, max_umol)
            if target is None:
                log.debug("%s: авто-резолюція не дала результату (не мало б статись)", label)
                return "skipped"

            key = (zone, channel)
            if self._last_sent.get(key) == target:
                log.debug("%s: без змін (%s%%, датчик=%.1f μmol)", label, target, sensor_umol)
                return "unchanged"

            log.info(
                "%s: auto -> %s%% (датчик=%.1f μmol, max_umol=%.1f)",
                label, target, sensor_umol, max_umol
            )
            self.state.apply_timer_brightness(zone, channel, target)
            self._last_sent[key] = target
            return "sent"

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
        if self._last_sent.get(key) == target:
            log.debug("%s: без змін (%s%%)", label, target)
            return "unchanged"

        nxt = next_change(points, now_minutes)
        log.info(
            "%s: timer -> %s%% (наступна зміна о %s)",
            label, target, nxt.time_str if nxt else "-",
        )
        self.state.apply_timer_brightness(zone, channel, target)
        self._last_sent[key] = target
        return "sent"
