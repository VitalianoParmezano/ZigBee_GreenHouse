"""
Точка входу для реального запуску сервісу (потрібен живий MQTT-брокер).
Налаштування — через .env (скопіюй .env.example -> .env і відредагуй).
"""
import traceback

from scheduler.service import SchedulerService

if __name__ == "__main__":
    try:
        SchedulerService().start()
    except Exception:
        # Без цього при подвійному кліку на файл (Windows) термінал
        # відкривається, падає з помилкою і одразу закривається — і
        # помилку прочитати неможливо. Тому ловимо все і чекаємо на Enter.
        print("\n=== СЕРВІС АВАРІЙНО ЗУПИНИВСЯ ===")
        traceback.print_exc()
        print("=================================")
        input("\nНатисни Enter, щоб закрити вікно...")
