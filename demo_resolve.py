"""
Автономна демонстрація алгоритму резолюції розкладу — БЕЗ MQTT і БЕЗ
брокера. Показує, яка яскравість діяла б ЗАРАЗ (реальний системний час
за замовчуванням) або о вказаний момент (--now HH:MM), плюс повну
таблицю по всій добі й просту ASCII-шкалу.

Запуск:
    python demo_resolve.py                # поточний реальний час
    python demo_resolve.py --now 14:37    # конкретний момент
    python demo_resolve.py --table        # + повна таблиця по всій добі
"""
import argparse
from datetime import datetime

from scheduler.schedule_logic import next_change, parse_scenarios, resolve_target_brightness

# Той самий формат, що записує _attachTimerListeners у greenhouse-zone-card.js
SAMPLE_SCENARIOS = [
    {"time": "07:00", "brightness": 20},
    {"time": "08:30", "brightness": 80},
    {"time": "20:00", "brightness": 40},
    {"time": "23:00", "brightness": 0},
]


def _to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _timeline(points, now_minutes: int, width: int = 48) -> str:
    """Проста ASCII-шкала доби: символ на кожні 30 хв, ▲ де ми зараз."""
    step = 1440 // width
    bar = []
    for i in range(width):
        slot_minutes = i * step
        b = resolve_target_brightness(points, slot_minutes) or 0
        # 4 градації щільності залежно від яскравості
        char = " " if b == 0 else ("░" if b < 34 else ("▒" if b < 67 else "█"))
        bar.append(char)
    cursor_pos = min(width - 1, now_minutes // step)
    pointer = [" "] * width
    pointer[cursor_pos] = "▲"
    return "".join(bar) + "\n" + "".join(pointer) + f"   <- зараз ({now_minutes // 60:02d}:{now_minutes % 60:02d})"


def main() -> None:
    parser = argparse.ArgumentParser(description="Демо резолюції таймерного розкладу")
    parser.add_argument("--now", type=str, default=None, help="Момент часу у форматі HH:MM (за замовчуванням — реальний поточний час)")
    parser.add_argument("--table", action="store_true", help="Показати повну таблицю по всій добі (кожні 30 хв)")
    args = parser.parse_args()

    points = parse_scenarios(SAMPLE_SCENARIOS)
    now_minutes = _to_minutes(args.now) if args.now else datetime.now().hour * 60 + datetime.now().minute

    print("Вхідний розклад (відсортований за часом):")
    for p in points:
        print(f"  {p.time_str} -> {p.brightness}%")
    print()

    target = resolve_target_brightness(points, now_minutes)
    nxt = next_change(points, now_minutes)
    now_str = f"{now_minutes // 60:02d}:{now_minutes % 60:02d}"
    print(f"Зараз {now_str} -> яскравість {target}% (наступна зміна о {nxt.time_str if nxt else '-'})")
    print()
    print(_timeline(points, now_minutes))

    if args.table:
        print("\nПовна таблиця (крок 30 хв):")
        for m in range(0, 1440, 30):
            t = f"{m // 60:02d}:{m % 60:02d}"
            b = resolve_target_brightness(points, m)
            print(f"  {t}  =>  {b}%")


if __name__ == "__main__":
    main()
