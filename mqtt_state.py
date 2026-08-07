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
                                                 scenarios, offline_brightness,
                                                 brightness)
    LogicService/Zone_x_Channel_y/get        <- запит стану; порожній
                                                 payload -> усі поля,
                                                 {"a":1,"b":2} або ["a","b"]
                                                 -> тільки перелічені поля.
                                                 Відповідь публікується
                                                 НАЗАД у той самий топік.
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

    def __init__(self, store: Optional[ChannelStore] = None) -> None:
        self.store = store or ChannelStore()

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
        log.debug("Підписано на %s/+/set і %s/+/get", self.CONTROL_PREFIX, self.CONTROL_PREFIX)
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
        prefix = f"{self.CONTROL_PREFIX}/"
        if not msg.topic.startswith(prefix):
            return
        rest = msg.topic[len(prefix):]  # "Zone_1_Channel_2/set" або ".../get"

        if rest.endswith("/set"):
            self._handle_set(rest[: -len("/set")], msg.payload)
        elif rest.endswith("/get"):
            self._handle_get(rest[: -len("/get")], msg.payload)

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
