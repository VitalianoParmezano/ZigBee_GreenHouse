# 🌿 Smart Greenhouse Zigbee Router (ESP32-H2)

![Zigbee Ready](https://img.shields.io/badge/Zigbee-3.0-orange?style=for-the-badge&logo=zigbee)
![Platform](https://img.shields.io/badge/Platform-ESP--IDF-blue?style=for-the-badge&logo=espressif)
![Status](https://img.shields.io/badge/Status-In%20Development-green?style=for-the-badge)

Професійний Zigbee-роутер та контролер каналів для автоматизації теплиць. Побудований на базі енергоефективного чіпа **ESP32-H2**, цей пристрій поєднує в собі функції розширювача мережі (Range Extender) та багатоканального реле.


## Технічні характеристики

- **MCU:** Espressif ESP32-H2 (IEEE 802.15.4)
- **Role:** Zigbee Router (ZR) — працює як ретранслятор сигналу.
- **Protocol:** Zigbee 3.0
- **Manufacturer:** `ElectroSvit`
- **Model ID:** `Retranslator_H2`
- **Power Source:** Mains (Single Phase)

## 🏗 Архітектура Ендпоінтів

Для керування теплицею пристрій використовує розділені канали (Endpoints), що дозволяє незалежно керувати різними підсистемами:

| Endpoint | Функція | Кластер | Опис |
| :--- | :--- | :--- | :--- |
| **EP 1** | Main Router | `Basic` | Системна інформація та ретрансляція мережі. |
| **EP 2** | Brightness CH1 | `LevelCtrl` | Керування яскравістю 1-го каналу. |
| **EP 3** | Brightness CH2 | `LevelCtrl` | Керування яскравістю 2-го каналу. |
| **EP 4** | Brightness CH3 | `LevelCtrl` | Керування яскравістю 3-го каналу. |


