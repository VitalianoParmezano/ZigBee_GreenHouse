# lighting-scheduler (LogicService)

Python-сервіс таймерного розкладу освітлення. Детальна архітектура - у
коментарях на початку `scheduler/mqtt_state.py`.

---

Перед першим запуском:
1. У `docker-compose.yml` постав правильний `devices:` шлях для
   Zigbee-координатора в сервісі `zigbee2mqtt` (`ls /dev/serial/by-id/`,
   щоб знайти стабільний шлях, а не `/dev/ttyUSB0`, який може зміститись
   після перезавантаження).
2. `lighting-scheduler/config.yaml` - `mqtt.host: mosquitto` (ім'я
   сервісу, НЕ `localhost` - це правило Docker-мереж, не специфіка цього
   проєкту).
3. `TZ=Europe/Kyiv` у кожному сервісі - постав свій часовий пояс, інакше
   контейнери рахуватимуть час за UTC, і резолюція розкладу поїде.

Весь каталог `lighting-scheduler/` змонтований у контейнер `logicservice`
як bind volume (`- ./lighting-scheduler:/app` у `docker-compose.yml`) -
код, `config.yaml` і `scheduler_state.sqlite3` (з'явиться сама після
першого запуску) лежать РАЗОМ, прямо на хості. Правиш код на хості -
контейнер підхоплює зміни без пересборки образу (`docker compose restart
logicservice` - і досить, `python main.py` перечитає файли заново).

## Запуск без Docker

```bash
python -m venv venv
source venv/bin/activate         # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp config.example.yaml config.yaml   # postaв mqtt.host: localhost (не mosquitto!)
python main.py                       # dry_run: true за замовчуванням
```

