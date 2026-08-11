# lighting-scheduler (прототип для рев'ю)

Прототип для перевірки алгоритму + архітектури таймерного розкладу.

## Ключове архітектурне рішення

ESP має стандартний brightness-кластер (genLevelCtrl/genOnOff), кластер бут статусу та оффлайн яскравості.

- Z2M/ESP розуміють тільки `brightness`/`state` - звичайна zigbee-лампа.
- `mode`, `scenarios`, `offline_brightness` живуть ЛИШЕ в локальній
  SQLite цього сервісу (`scheduler_state.sqlite3`) - для них немає
  жодного бекенду ні в прошивці, ні в Z2M.
- Керування ними йде через ВЛАСНИЙ топік-простір `lighting-scheduler/*`,
  а не через `zigbee2mqtt/*` - Z2M про ці дані взагалі нічого не знає.

```
Картка (HA) --{"mode":"timer"}--> lighting-scheduler/Zone_1_Channel_2/set
                                          |
                                   SQLite (mode+scenarios+offline_brightness)
                                          |
                                   резолюція (schedule_logic.py)
                                          |
                                   zigbee2mqtt/Zone_1_Channel_2/set {"brightness": X}
                                          |
                                        ESP32 (тільки brightness-кластер)
```

Підтверджений (не оптимістичний) стан публікується назад у
`lighting-scheduler/Zone_1_Channel_2` (retained) - картка читає звідти.

## Структура

- `scheduler/config.py` - налаштування з `config.yaml` (НЕ env).
- `scheduler/store.py` - SQLite: mode/scenarios/offline_brightness по
  зонах/каналах. Єдине джерело правди для розкладу.
- `scheduler/mqtt_state.py` - два незалежні MQTT-простори: керування
  (`lighting-scheduler/*`, наше) і реальні команди (`zigbee2mqtt/*/set`,
  для ESP).
- `scheduler/schedule_logic.py` - чиста логіка резолюції (без MQTT).
- `scheduler/service.py` - тіковий цикл: читає конфіг з SQLite, рахує
  цільову яскравість, публікує в zigbee2mqtt, якщо змінилось.
- `demo_resolve.py` - офлайн-демо без MQTT і без конфіга.
- `main.py` - точка входу (потрібен живий брокер).

## Швидкий перегляд без брокера

```bash
python demo_resolve.py
python demo_resolve.py --now 21:15 --table
```

## Запуск

```bash
python -m venv venv
source venv/bin/activate         # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp config.example.yaml config.yaml   # відредагувати mqtt.host/port/user
python main.py                       # dry_run: true за замовчуванням
```

`scheduler_state.sqlite3` створюється автоматично поруч з `main.py` при
першому запуску - це і є ваша база розкладів, тримайте її локально
(бекапте, якщо не хочете втратити налаштовані сценарії).

## Оновлення картки (greenhouse-zone-card.js)

Публікацію scenarios/mode потрібно перенаправити з
`zigbee2mqtt/<group>/set` на `lighting-scheduler/<group>/set` - Z2M
більше не бере участі в цих даних. Читання поточного стану - з
`lighting-scheduler/<group>` (retained), а не з кешу групи Z2M.

## Якщо термінал одразу закривається

Найчастіша причина - `python main.py` запущено НЕ з уже відкритого
терміналу, і помилка (нема `config.yaml`, брокер недоступний, залежності
не встановлені) валить процес одразу. `main.py` ловить помилку, друкує
traceback і чекає на Enter - запускай з терміналу, щоб побачити текст.

## ModuleNotFoundError: No module named 'scheduler'

Розпакуй ВЕСЬ архів разом - `scheduler/` має лежати поруч з `main.py`:

```
LogicService/
  main.py
  config.yaml
  scheduler/
    __init__.py
    config.py
    store.py
    mqtt_state.py
    schedule_logic.py
    service.py
```

Запускай `python main.py` саме з теки `LogicService`.
