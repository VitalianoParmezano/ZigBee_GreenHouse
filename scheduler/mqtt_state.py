"""
MQTT-шар LogicService з ДВОМА окремими зонами відповідальності:

1. Реальний zigbee2mqtt - тільки для brightness/state (те, що ESP і Z2M
   дійсно розуміють - жодних кастомних кластерів більше немає).
2. Власний топік-простір `LogicService/*` - для mode/scenarios/
   offline_brightness/brightness, які живуть ЛИШЕ в локальній SQLite
   (store.py), бо в Zigbee/Z2M для них немає жодного бекенду.

Контракт LogicService/*:
    LogicService/Zone_x_Channel_y            <- retained broadcast повного
                                                 стану після кожної зміни
    LogicService/Zone_x_Channel_y/set        <- команди запису (mode,
                                                 scenarios, ,
                                                 offline_brightness, brightness)
    LogicService/Zone_x_Channel_y/get        <- запит стану; порожній
                                                 payload -> усі поля,
                                                 {"a":1,"b":2} або ["a","b"]
                                                 -> тільки перелічені поля.
                                                 Відповідь публікується
                                                 НАЗАД у той самий топік.
    LogicService/bridge/sensor               <- глобальний (не по зоні)
                                                 показник датчика:
                                                 {"lux": 1554}. Використо-
                                                 вується авторежимом
                                                 (schedule_logic.resolve_auto_brightness).

Читання сенсору:
 Сервіс слухає zigbee2mqtt/+ , тобто усі пристрої і якщо якийсь із них присилає JSON з ключем "illuminance",
то сервіс бере це значення і публікує у LogicService/bridge/sensor {"lux": 1234}.

 По-факту виконує роль пересилки. Пізніше якщо додавати нові датчики: у LogicService/bridge/sensor 
слати усереднене значення (якщо уся теплиця працює за одним авторежимом) або розширити топіки на LogicService/bridge/sensor/zone1, zone2 і т.д.
але це вже інша історія, для цього треба буде створювати новий екстеншин і кожному сенсору присвоювати зону.


"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

import paho.mqtt.client as mqtt

from .config import settings
from .store import ChannelStore

log = logging.getLogger("mqtt_state")

_GROUP_RE = re.compile(r"^Zone_(\d+)_Channel_(\d+)$")
_ALL_FIELDS = ("mode", "scenarios", "offline_brightness", "brightness", "state")

# Стандартні коди CONNACK з MQTT 3.1.1 - щоб не гадати, чому rc != 0
_CONNACK_REASONS = {
    0: "з'єднання успішне",
    1: "брокер відхилив: неправильна версія протоколу",
    2: "брокер відхилив: ідентифікатор клієнта неприйнятний",
    3: "брокер відхилив: сервіс недоступний",
    4: "брокер відхилив: неправильні mqtt.user/mqtt.password",
    5: "брокер відхилив: не авторизовано (ACL/права доступу)",
}


def group_name(zone: int, channel: int) -> str:
    return f"Zone_{zone}_Channel_{channel}"


def _parse_group_name(name: str) -> Optional[tuple[int, int]]:
    m = _GROUP_RE.match(name)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def _parse_requested_fields(payload_bytes: bytes) -> Optional[list[str]]:
    """None = повернути все (порожній payload). Інакше - список полів."""
    if not payload_bytes or not payload_bytes.strip():
        return None
    try:
        data = json.loads(payload_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if isinstance(data, list) and data:
        return [str(x) for x in data]
    if isinstance(data, dict) and data:
        return list(data.keys())
    return None  # {} або [] теж трактуємо як "усе"


def _with_derived_state(cfg: dict[str, Any]) -> dict[str, Any]:
    full = dict(cfg)
    full["state"] = "ON" if cfg.get("brightness", 0) > 0 else "OFF"
    return full


class MqttState:
    CONTROL_PREFIX = "LogicService"
    ZIGBEE_PREFIX = "zigbee2mqtt"

    def __init__(self, store: Optional[ChannelStore] = None) -> None:
        self.store = store or ChannelStore()
        # Останній відомий показник датчика (μmol/m²/s) - для авторежиму.
        # 0.0 за замовчуванням, поки не прийшло жодне повідомлення в
        # bridge/sensor (консервативний дефолт: без даних датчика авторежим
        # видає повний базовий відсоток з розкладу, а не занижений).
        self.sensor_lux: float = 0.0

        self._client = mqtt.Client(client_id="LogicService", protocol=mqtt.MQTTv311)
        if settings.mqtt_user:
            self._client.username_pw_set(settings.mqtt_user, settings.mqtt_password)
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.on_disconnect = self._on_disconnect

    # ------------------------------------------------------------------ #
    def connect(self) -> None:
        log.debug("Підключення до брокера %s:%s...", settings.mqtt_host, settings.mqtt_port)
        self._client.connect(settings.mqtt_host, settings.mqtt_port, keepalive=30)
        self._client.loop_start()

    def disconnect(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()
        self.store.close()

    # ------------------------------------------------------------------ #
    def _on_connect(self, client, userdata, flags, rc) -> None:
        if rc != 0:
            reason = _CONNACK_REASONS.get(rc, f"невідомий код {rc}")
            log.error("MQTT НЕ підключився: rc=%s (%s)", rc, reason)
            log.error("Підписки НЕ відбулись - саме тому нічого не приходить/не публікується.")
            return
        log.info("MQTT connected (rc=%s)", rc)
        client.subscribe(f"{self.CONTROL_PREFIX}/+/set")
        client.subscribe(f"{self.CONTROL_PREFIX}/+/get")
        client.subscribe(f"{self.CONTROL_PREFIX}/bridge/sensor")
        client.subscribe(f"{self.CONTROL_PREFIX}/bridge/max_umol")
        client.subscribe(f"{self.ZIGBEE_PREFIX}/+")
        log.debug(
            "Підписано на %s/+/set, %s/+/get, %s/bridge/sensor, %s/bridge/max_umol, %s/+",
            self.CONTROL_PREFIX, self.CONTROL_PREFIX, self.CONTROL_PREFIX, self.CONTROL_PREFIX, self.ZIGBEE_PREFIX,
        )
        self._publish_startup_snapshot()

    def _on_disconnect(self, client, userdata, rc) -> None:
        if rc != 0:
            log.warning("MQTT неочікувано відключився (rc=%s) - paho спробує перепідключитись автоматично", rc)
        else:
            log.debug("MQTT відключено штатно")

    # ------------------------------------------------------------------ #
    def _publish_startup_snapshot(self) -> None:
        """Аналог того, що робить Z2M одразу після підключення (bridge/devices,
        bridge/groups) - публікує LogicService/bridge/info і поточний стан
        УСІХ зон/каналів (retained), навіть якщо це ще дефолтні значення.
        Так усі топіки видно одразу в MQTT-клієнті, не чекаючи першого /set.
        Викликається на КОЖНЕ підключення, включно з автоматичним
        перепідключенням paho - так само, як це робить Z2M."""
        info = {
            "dry_run": settings.dry_run,
            "tick_interval_sec": settings.tick_interval_sec,
            "zones": settings.zones,
            "channels_per_zone": settings.channels_per_zone,
            "log_level": settings.log_level,
        }
        self._client.publish(f"{self.CONTROL_PREFIX}/bridge/info", json.dumps(info), retain=True)

        count = 0
        for zone in range(1, settings.zones + 1):
            for channel in range(1, settings.channels_per_zone + 1):
                group = group_name(zone, channel)
                self._broadcast(group, self.store.get(zone, channel))
                count += 1

        log.info(
            "Опубліковано стартовий знімок: %s/bridge/info + стан %s каналів (%s zones x %s channels)",
            self.CONTROL_PREFIX, count, settings.zones, settings.channels_per_zone,
        )

    def _on_message(self, client, userdata, msg: "mqtt.MQTTMessage") -> None:
        zigbee_prefix = f"{self.ZIGBEE_PREFIX}/"
        prefix = f"{self.CONTROL_PREFIX}/"

        if msg.topic.startswith(zigbee_prefix):
            # Якщо це системне повідомлення Z2M (bridge) - ігноруємо його
            if msg.topic.startswith(f"{self.ZIGBEE_PREFIX}/bridge/") or msg.topic.startswith(f"{self.ZIGBEE_PREFIX}/Zone"):
                return
            self._scan_payload_for_lux(msg.payload)
            return # Обов'язково виходимо, бо це топік Z2M, а нижче код для LogicService

        if not msg.topic.startswith(prefix):
            return
        rest = msg.topic[len(prefix):]  # "Zone_1_Channel_2/set", ".../get" або "bridge/sensor"

        if rest == "bridge/sensor":
            log.debug("Отримано bridge/sensor: %r", msg.payload)
            self._handle_sensor_reading(msg.payload)
            return

        if rest == "bridge/max_umol":
            print("Lol kek cheburek")
            self._handle_max_umol_update(msg.payload)
            return

        if rest.endswith("/set"):
            self._handle_set(rest[: -len("/set")], msg.payload)
        elif rest.endswith("/get"):
            self._handle_get(rest[: -len("/get")], msg.payload)

    def _handle_sensor_reading(self, payload_bytes: bytes) -> None:
        try:
            data = json.loads(payload_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("bridge/sensor: некоректний JSON: %r", payload_bytes)
            return

        lux = data.get("lux") if isinstance(data, dict) else None
        if lux is None:
            log.warning("bridge/sensor: немає ключа 'lux' у %r", data)
            return

        try:
            self.sensor_lux = float(lux)
        except (TypeError, ValueError):
            log.warning("bridge/sensor: некоректне значення lux: %r", lux)
            return

        log.debug("Показник датчика оновлено: %.1f lux", self.sensor_lux)

    def get_sensor_lux(self) -> float:
        return self.sensor_lux

    # ------------------------------------------------------------------ #
    def _handle_set(self, group: str, payload_bytes: bytes) -> None:
        parsed = _parse_group_name(group)
        if parsed is None:
            log.warning("SET: не вдалось розпарсити зону/канал з '%s'", group)
            return
        zone, channel = parsed

        try:
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("SET %s: некоректний JSON: %r", group, payload_bytes)
            return
        if not isinstance(payload, dict):
            log.warning("SET %s: очікувався JSON-об'єкт, отримано %r", group, payload)
            return

        updated = self.store.update(zone, channel, payload)
        log.info("SET %s <- %s => збережено %s", group, payload, updated)

        # brightness - СПІЛЬНЕ поле для manual і timer. Явна команда з /set -
        # це завжди миттєве керування (не чекаємо наступного тіку), незалежно
        # від того, в якому mode зараз канал: timer на наступному тіку просто
        # порахує й перезапише це значення знову, якщо треба.
        if "brightness" in payload:
            self._publish_zigbee_brightness(zone, channel, int(payload["brightness"]))

        self._broadcast(group, updated)

    def _handle_get(self, group: str, payload_bytes: bytes) -> None:
        parsed = _parse_group_name(group)
        if parsed is None:
            log.warning("GET: не вдалось розпарсити зону/канал з '%s'", group)
            return
        zone, channel = parsed

        requested = _parse_requested_fields(payload_bytes)
        full = _with_derived_state(self.store.get(zone, channel))
        response = full if requested is None else {k: full[k] for k in requested if k in full}

        topic = f"{self.CONTROL_PREFIX}/{group}/get"
        self._client.publish(topic, json.dumps(response))
        log.debug("GET %s (поля=%s) -> %s", group, requested or "усі", response)

    def _broadcast(self, group: str, cfg: dict[str, Any]) -> None:
        """Retained-повідомлення повного стану в базовий топік (без /set, /get) -
        зручно для будь-кого, хто просто хоче спостерігати за змінами."""
        full = _with_derived_state(cfg)
        self._client.publish(f"{self.CONTROL_PREFIX}/{group}", json.dumps(full), retain=True)

    # ------------------------------------------------------------------ #
    def apply_timer_brightness(self, zone: int, channel: int, target: int) -> None:
        """Викликається з тікового циклу сервісу, коли timer-режим порахував
        нове значення. Пише в ТЕ САМЕ поле 'brightness', що й ручне /set -
        GET завжди повертає актуальне значення незалежно від джерела."""
        group = group_name(zone, channel)
        updated = self.store.update(zone, channel, {"brightness": target})
        self._publish_zigbee_brightness(zone, channel, target)
        self._broadcast(group, updated)

    def get_channel_config(self, zone: int, channel: int) -> dict[str, Any]:
        return self.store.get(zone, channel)
    # ------------------------------------------------------------------ #

    def _handle_max_umol_update(self, payload_bytes: bytes) -> None:
        # КРОК 1: Перетворюємо байти, що прийшли з MQTT, у зрозумілий Python-словник (dict)
        try:
            data = json.loads(payload_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("bridge/max_umol: некоректний JSON: %r", payload_bytes)
            return

        #  Перевірака, чи прийшов саме словник (об'єкт {})
        if not isinstance(data, dict):
            log.warning("bridge/max_umol: очікувався JSON-об'єкт, отримано %r", data)
            return

        # З фронтенду приходить: {"max_umol_channel1": 10, "max_umol_channel2": 150}
        # Метод .items() розбиває це на пари: 
        # key_str = "max_umol_channel1", max_umol = 10
        for key_str, max_umol in data.items():
            try:
                # Відрізаємо зайві літери. replace("max_umol_channel", "") 
                # перетворює "max_umol_channel1" просто на "1"
                channel_str = key_str.replace("max_umol_channel", "")
                
                # Робимо з тексту "1" справжнє число 1 для бази даних
                channel = int(channel_str)
                
                # Робимо з 10 справжнє число з крапкою 10.0 (float)
                max_umol_value = float(max_umol)
                
                # КРОК 4: Передаємо готові цифри у ваш метод збереження в SQLite
                self.store.update_lamp_max_umol(channel, max_umol_value)
                
            except (ValueError, TypeError):
                # Якщо раптом прийшло "max_umol_channelXXX": "текст", код не впаде, а просто залогує помилку
                log.warning("bridge/max_umol: некоректне значення для ключа=%s: %r", key_str, max_umol)
                
        # Рапорт, що все успішно збережено
        log.info("bridge/max_umol: успішно оновлено максимальні μmol: %s", data)

    # ------------------------------------------------------------------ #
    def _publish_zigbee_brightness(self, zone: int, channel: int, brightness_pct: int, transition: float = 2.0) -> None:
        """Єдине, що йде в реальний zigbee2mqtt - ESP розуміє тільки це.
        Шлемо і `state`, і `brightness` явно - не покладаємось на те, що
        прошивка сама вимкне світло при brightness=0."""
        base = settings.mqtt_base_topic
        group = group_name(zone, channel)
        topic = f"{base}/{group}/set"
        payload = json.dumps({
            "state": "ON" if brightness_pct > 0 else "OFF",
            "brightness": brightness_pct,
            "transition": transition,
        })

        if settings.dry_run:
            log.info("[DRY-RUN] -> %s : %s", topic, payload)
            return

        self._client.publish(topic, payload)
        log.info("-> %s : %s", topic, payload)

    def _scan_payload_for_lux(self, payload_bytes: bytes) -> None:
        if not payload_bytes:
            return
            
        try:
            data = json.loads(payload_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Мовчки ігноруємо, якщо це не JSON
            return

        if not isinstance(data, dict):
            return

        # Шукаємо ключ illuminance 
        lux = data.get("illuminance")

        # Якщо нічого з цього не знайшли — це просто інший девайс (наприклад, вимикач).
        # Мовчки виходимо.
        if lux is None:
            return

        # Якщо ж знайшли — намагаємось відправити
        try:
            # Переконуємося, що це число (щоб не відправити якийсь текст типу "N/A")
            lux_value = float(lux)
            
            # Формуємо правильний топік: "LogicService/bridge/sensor"
            topic = f"{self.CONTROL_PREFIX}/bridge/sensor"
            
            # Пакуємо в потрібний формат payload
            payload = json.dumps({"lux": lux_value})
            
            self._client.publish(topic, payload)
            
            # Залишаємо легкий дебаг-лог, щоб ти бачив, що сканер спрацював
            log.debug("Сканер знайшов люкси і переслав у %s: %s", topic, payload)
            
        except (TypeError, ValueError):
            # Якщо значення прийшло бите, просто ігноруємо
            pass