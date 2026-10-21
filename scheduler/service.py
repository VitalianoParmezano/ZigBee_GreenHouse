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
import threading
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .config import PROJECT_ROOT, settings
from .mqtt_state import MqttState
from .schedule_logic import next_change, parse_scenarios, auto_correction_resolve, resolve_scenario_target_brightness, pbd_limit

log = logging.getLogger("service")


class SchedulerService:
    def __init__(self) -> None:
        self.state = MqttState()
        self.store = store.ChannelStore()
        # (zone, channel) -> останнє застосоване timer-ом значення, щоб не
        # спамити мережу однаковою командою щотіку, поки нічого не змінилось.
        self._last_sent: dict[tuple[int, int], int] = {}
        self.state.on_set = self.process_zone      # /set буде кликати цей метод
        self._lock = threading.Lock()              # тік і MQTT-потік не повинні рахувати одночасно 

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
            "log_level=%s, log_dir=%s, retention=%sд, transition=%s)",
            settings.dry_run, settings.tick_interval_sec, settings.zones,
            settings.channels_per_zone, settings.log_level, log_dir, settings.log_retention_days,
            settings.transition,
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
        for zone in range(1, settings.zones + 1):
            self.process_zone(zone)

    # Цей метод викликається з двох потоків: тік і коли приходить /set.
    def process_zone(self, zone: int) -> None:
        with self._lock:
            now = datetime.now()
            now_minutes = now.hour * 60 + now.minute
            channels = range(1, settings.channels_per_zone + 1)

            targets = {ch: self._resolve_channel(zone, ch, now_minutes) for ch in channels}

            # ---------- PBD ----------
            pw = settings.power
            if pw.enabled:
                targets = pbd_limit(targets, pw.channel_watts, pw.max_watts, pw.yield_channel)

            # ---------- AUTO ----------
            auto_targets = {
                ch: targets[ch] for ch in channels
                if self.state.get_channel_config(zone, ch)["auto"]
            }
            if auto_targets:
                targets.update(auto_correction_resolve(
                    auto_targets,
                    self.state.get_sensor_lux(),
                    self.state.store.get_all_lamp_max_umols(),
                ))

            # ---------- відправка ----------
            for ch, value in targets.items():
                self.state.apply_brightness(zone, ch, value)

    def _resolve_channel(self, zone: int, channel: int, now_minutes: int) -> int:
        label = f"Zone {zone} / Channel {channel}"
        cfg = self.state.get_channel_config(zone, channel)
        mode = cfg["mode"]

        if mode == "manual":
            target = cfg.get("brightness_user") or 0
            log.debug("%s: manual -> %s%%", label, target)

        elif mode == "timer":
            points = parse_scenarios(cfg["scenarios"])
            target = resolve_scenario_target_brightness(points, now_minutes) if points else None
            if target is None:
                log.debug("%s: timer без розкладу -> 0%%", label)
                target = 0
            nxt = next_change(points, now_minutes) if points else None
            log.info("%s: timer -> %s%% (наступна зміна о %s)",
                    label, target, nxt.time_str if nxt else "-")

        else:
            log.warning("%s: невідомий mode=%r -> 0%%", label, mode)
            return 0

        return int(target)