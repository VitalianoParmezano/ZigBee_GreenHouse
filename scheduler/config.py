"""
Конфігурація сервісу - з YAML-файлу, а НЕ зі змінних середовища.

За замовчуванням шукає config.yaml поруч з main.py (корінь проєкту).
Інший шлях можна передати першим аргументом командного рядка:
    python main.py my-config.yaml
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def _resolve_config_path() -> Path:
    for arg in sys.argv[1:]:
        if arg.endswith(".yaml") or arg.endswith(".yml"):
            return Path(arg)
    return DEFAULT_CONFIG_PATH


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(
            f"Конфiг-файл не знайдено: {path}\n"
            f"Скопiюй config.example.yaml -> config.yaml (поруч з main.py) i вiдредагуй його."
        )
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Конфiг-файл {path} порожнiй або має неправильний формат (очiкується YAML-об'єкт).")
    return data


@dataclass(frozen=True)
class Settings:
    mqtt_host: str
    mqtt_port: int
    mqtt_user: Optional[str]
    mqtt_password: Optional[str]
    mqtt_base_topic: str

    zones: int
    channels_per_zone: int
    tick_interval_sec: int
    dry_run: bool
    log_level: str
    log_dir: str
    log_retention_days: int
    umol_multiplier: float

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Settings":
        mqtt = raw.get("mqtt") or {}
        sched = raw.get("scheduler") or {}
        logging_cfg = raw.get("logging") or {}
        sensor_cfg = raw.get("sensor") or {}
        return cls(
            mqtt_host=str(mqtt.get("host", "localhost")),
            mqtt_port=int(mqtt.get("port", 1883)),
            mqtt_user=(mqtt.get("user") or None),
            mqtt_password=(mqtt.get("password") or None),
            mqtt_base_topic=str(mqtt.get("base_topic", "zigbee2mqtt")),
            zones=int(sched.get("zones", 6)),
            channels_per_zone=int(sched.get("channels_per_zone", 3)),
            tick_interval_sec=int(sched.get("tick_interval_sec", 30)),
            dry_run=bool(sched.get("dry_run", True)),
            log_level=str(logging_cfg.get("level", "INFO")).upper(),
            log_dir=str(logging_cfg.get("dir", "logs")),
            log_retention_days=int(logging_cfg.get("retention_days", 7)),
            umol_multiplier=float(sensor_cfg.get("umol_multiplier", 25.0)),
        )


_config_path = _resolve_config_path()
settings = Settings.from_dict(_load_yaml(_config_path))
