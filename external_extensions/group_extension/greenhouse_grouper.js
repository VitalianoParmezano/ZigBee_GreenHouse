/**

This extension automatically creates groups for each channel of a device based on its productLabel (DIP switch value).

Як це працює:
1. Коли новий пристрій приєднується та успішно проходить інтерв'ю, розпочинається фоновий процес налаштування груп.
2. Фоновий процес читає productLabel (DIP switch) з пристрою та створює (або знаходить існуючі) 3 групи для кожного каналу.
3. Якщо група вже існувала — після додавання нового члена його ендпоінт синхронізується з
   ОСТАННІМ ВІДОМИМ СТАНОМ ГРУПИ (this.state.get(групи)), включно з кастомними атрибутами
   (offline_brightness, scenarios), а не лише on/off + яскравістю.
   ВАЖЛИВО: цей кеш містить кастомні атрибути лише якщо ними керували через ТОПІК ГРУПИ
   (zigbee2mqtt/<group>/set), а не через топік окремого пристрою — інакше значення кешуються
   під конкретним пристроєм, а не групою, і синхронізація тут їх не побачить.
4. Якщо пристрій залишає мережу, всі його групи автоматично очищуються. [TODO: ще не реалізовано]

УВАГА: у Zigbee2MQTT 2.11+ зовнішні розширення завантажуються лише з увімкненим
advanced.enable_external_js, і документація описує їх у форматі .mjs (ESM).
Цей файл лишений у CommonJS-форматі, як і надісланий оригінал — перед розгортанням
на Z2M 2.x переконайся, що конвертуєш його на export default / .mjs.

 */
const SHIFT = 10; // Зміщення для Ендпоінтів з каналами. Налаштовується в самому пристрої і тут
const NUMBER_OF_CHANNELS = 3; // Кількість каналів на пристрої.
const transitionTime = 2; // Час переходу для груп (в секундах)
const BRIDGE_RESPONSE_TIMEOUT_MS = 3000;
const CHANNEL_CLUSTER = 0xFC01; // Кастомний кластер offline_brightness/scenarios на кожному каналі
const MAX_SCENARIOS = 12;
const BYTES_PER_SCENARIO = 3;

const now = new Date();
// Ті самі функції пакування, що і в external converter — тримати їх синхронізованими,
// або перенести в спільний модуль, якщо логіка почне розростатись.
function timeToMinutes(timeStr) {
    const [h, m] = String(timeStr).split(':').map(Number);
    return h * 60 + m;
}

function encodeScenarios(scenarios) {
    if (!Array.isArray(scenarios)) return Buffer.alloc(0);
    const sorted = [...scenarios].slice(0, MAX_SCENARIOS).sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    const buffer = Buffer.alloc(sorted.length * BYTES_PER_SCENARIO);
    sorted.forEach((s, i) => {
        const offset = i * BYTES_PER_SCENARIO;
        buffer.writeUInt16LE(timeToMinutes(s.time), offset);
        buffer.writeUInt8(Number(s.brightness), offset + 2);
    });
    return buffer;
}

class AutoGrouper {
    // Нам знадобиться об'єкт state, щоб читати поточний стан пристрою
    constructor(zigbee, mqtt, state, _4, eventBus) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.eventBus = eventBus;
        this.state = state;
    }

    start() {
        console.log('🌿 [AutoGrouper] STARTED. Listening for state changes...');

        this.eventBus.onDeviceInterview(this, this.onDeviceInterview.bind(this));
        this.eventBus.onDeviceJoined(this, this.onDeviceJoined.bind(this));

        this.eventBus.onStateChange(this, this.onStateChange.bind(this));
        //this.eventBus.onDeviceLeave(this, this.onDeviceLeave.bind(this));
    }

    stop() {
        this.eventBus.removeListeners(this);
        console.log('🌿 [AutoGrouper] STOPPED.');
    }

    async onDeviceJoined(data) {
        console.log(`🌿 [AutoGrouper] Device joined: ${data.device.ieeeAddr}`);
    }

    // Інтерв'ю девайсів, коли новий девай конектиться
    async onDeviceInterview(data) {
        if (data.status !== 'successful') return;

        console.log(`🌿 [AutoGrouper] Interview successful for: ${data.device.ieeeAddr}. Запускаю фоновий процес...`);

        this.setupDevicesInBackground(data.device).catch((err) => {
            
            console.error(`🌿 [AutoGrouper] ❌ Помилка у фоновому процесі: ${err.message}`);
        });
        console.log(`🌿 [AutoGrouper] Процес налаштування пристрою ${data.device} запущено.`);
    }

    // Перевірка bootMode
    async onStateChange(data) {
        // data містить: { entity (об'єкт пристрою/групи), from (старий стан), to (новий стан) }
        
        if (!data.entity || data.entity.isGroup()) return;

        // Приклад: ловимо зміну нашого boot_status
        const newBootStatus = data.to?.boot_status;
        const oldBootStatus = data.from?.boot_status;
        
        const basicEndpoint = data.entity.zh.getEndpoint(1);
        const result = await basicEndpoint.read('genBasic', ['productLabel']);
        
        if (data.update && data.update.boot_status === 0) {
            console.log(`\n🌿 Отримано boot_status = 0 від ${data.entity.name}!`);
            
            this.setupDevicesInBackground(data.entity).catch((err) => {
                console.error(`🌿 [AutoGrouper] Device configuration failure (via update): ${err.message}`);
            });

            
            return; 
        }

    }

    // Вся логіка з MQTT винесена в окремий фоновий метод
async setupDevicesInBackground(device) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        console.log(`\n🌿 [AutoGrouper-BG] === Налаштування груп ===`);

        const basicEndpoint = device.zh.getEndpoint(1);
        let myLabel;

        if (basicEndpoint) {
            try {
                console.log(`🌿 [AutoGrouper-BG] Зчитування productLabel...`);
                const result = await basicEndpoint.read('genBasic', ['productLabel']);
                myLabel = result?.productLabel;
            } catch (error) {
                console.error(`🌿 [AutoGrouper-BG] Помилка читання: ${error.message}`);
            }
        }

        if (!myLabel || isNaN(Number(myLabel))) return;

        const deviceFriendlyName = device.name;

        // ---------------------------------------------------------------
        // синхронізація системних метаданих пристрою (EP2) перед роботою з каналами.
        // відновлюється режим (mode), час (device_time) та виставляється boot_status = 1.
        // ---------------------------------------------------------------
        await this.syncNewMemberFromDeviceState(device);

        for (let i = 1; i <= NUMBER_OF_CHANNELS; i++) {
            const group_ID = Number(myLabel) * 10 + i;
            const channelName = `Channel_${i}`;
            const groupName = `Zone_${myLabel}_${channelName}`;
            const endpointID = i + SHIFT;

            if (!device.zh.getEndpoint(endpointID)) continue;

            console.log(`\n🌿 [AutoGrouper-BG] Обробка групи ${groupName} (ID: ${group_ID})...`);

            // ---------------------------------------------------------------
            // створення групи, з перевіркою, чи вона вже існувала.
            // ---------------------------------------------------------------
            const groupAlreadyExisted = await this.ensureGroupExists(groupName, group_ID);

            // ---------------------------------------------------------------
            // додавання ендпоінту цього пристрою до групи.
            // ---------------------------------------------------------------
            console.log(`🌿 [AutoGrouper-BG] Додавання пристроя ${deviceFriendlyName} до групи ${groupName}, ендпоінт: ${endpointID}`);
            this.eventBus.emitMQTTMessage({
                topic: 'zigbee2mqtt/bridge/request/group/members/add',
                message: JSON.stringify({
                    group: groupName,
                    device: `${deviceFriendlyName}`,
                    endpoint: `${endpointID}`,
                    skip_disable_reporting: true,
                }),
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // ---------------------------------------------------------------
            // якщо група вже існувала — синхронізується новий член
            // з останнім відомим станом ГРУПИ (не якогось довільного пристрою).
            // ---------------------------------------------------------------
            if (groupAlreadyExisted) {
                await this.syncNewMemberFromGroupState(groupName, endpointID, device);
            } else {
                console.log(`🌿 [AutoGrouper-BG] Група щойно створена, немає відомого стану для синхронізації.`);
            }

            console.log(`🌿 [AutoGrouper-BG] Канал ${channelName} успішно налаштовано.`);
        }
        // Встановлення boot_status в 1        
        const systemEndpoint = device.zh.getEndpoint(2);
        if (systemEndpoint) {
            try {
                console.log(`🌿 [AutoGrouper-BG] Запис boot_status = 1 в пристрій ${device.ieeeAddr}`);
                await systemEndpoint.write(0xFF01, { 0x0000: { value: 1, type: 0x20 } });
                console.log(`🌿 [AutoGrouper-BG] boot_status = 1 успішно встановлено!`);
            } catch (err) {
                console.error(`🌿 [AutoGrouper-BG] Помилка запису boot_status: ${err.message}`);
            }
        }
    }


    /**
     * Синхронізує системні налаштування пристрою в цілому (Ендпоінт 2).
     * Відновлює або встановлює режим роботи (mode), поточний час та статус завантаження.
     * @param {Object} device - Об'єкт пристрою з zigbee-herdsman
     */
    async syncNewMemberFromDeviceState(device) {
        const SYSTEM_CLUSTER = 0xFF01;
        const MODE_MAP_REVERSE = { manual: 0, timer: 1, auto: 2 };

        // 1. Отримуємо 2-й ендпоінт, де живуть системні атрибути (mode, boot_status, device_time)
        const metadataEndpoint = device.zh.getEndpoint(2);
        if (!metadataEndpoint) {
            console.warn(`🌿 [AutoGrouper-BG] ❌ Не вдалось отримати EP2 (System) для пристрою ${device.ieeeAddr}.`);
            return;
        }

        // Читаємо останній відомий стан самого пристрою з кешу Z2M (state.json)
        const lastKnownState = this.state.get(device) || {};
        console.log(`🌿 [AutoGrouper-BG] Останні відомі системні дані пристрою ${device.ieeeAddr}:`, JSON.stringify(lastKnownState));

        // Визначаємо цільовий режим: беремо збережений з кешу АБО ставимо 'manual' за замовчуванням для нових плат
        const targetModeStr = lastKnownState.mode || 'manual';
        const targetModeNum = MODE_MAP_REVERSE[targetModeStr] ?? 2; // 2 = auto

        console.log(`🌿 [AutoGrouper-BG] Синхронізація плати "${device.name}" -> Режим: "${targetModeStr}" (${targetModeNum})...`);

        try {
            // ---  Синхронізація режиму роботи (Атрибут 1) ---
            await metadataEndpoint.write(SYSTEM_CLUSTER, {
                1: { value: targetModeNum, type: 0x20 } // 0x20 = uint8
            });
            console.log(`🌿 [AutoGrouper-BG] ✓ Режим "${targetModeStr}" успішно записано в пристрій ${device.ieeeAddr}.`);

            // Синхронізація часу
            // const localAsUtcSeconds = Date.UTC(
            //     now.getFullYear(), now.getMonth(), now.getDate(),
            //     now.getHours(), now.getMinutes(), now.getSeconds(),
            // ) / 1000;
            // const zigbeeTime = Math.floor(localAsUtcSeconds) - ZIGBEE_EPOCH_OFFSET;

            // // Записуємо в атрибут 0 з типом 0xE2 (UTCTime)
            // await metadataEndpoint.write('genTime', {
            //     0: { value: zigbeeTime, type: 0xE2 }
            // });
            
            //Покищо так, роботу з часом зробить конвертер
            this.eventBus.emitMQTTMessage({
                topic: `zigbee2mqtt/${device.ieeeAddr}/set`,
                message: JSON.stringify({ device_time: 0 }),
            });

            // ---  Скидання статусу завантаження (Атрибут 0) ---
            // Кажемо мікроконтролеру, що він успішно налаштований (boot_status = 1)

            console.log(`🌿 [AutoGrouper-BG] Синхронізація метаданних для "${device.name}" завершена успішно!`);

        } catch (error) {
            console.error(`🌿 [AutoGrouper-BG] Помилка запису в системний ендпоінт EP2: ${error.message}`);
        }
    }
    /**
     * Синхронізує щойно доданого члена групи з останнім відомим станом ГРУПИ.
     *
     * this.zigbee.resolveEntity(name) — недокументоване внутрішнє API, точна форма
     * повернутого об'єкта могла відрізнятись між версіями Z2M. Перед боєм рекомендується
     * один раз вивести console.log(JSON.stringify(Object.keys(groupEntity))) і за потреби
     * підправити groupEntity.group / groupEntity нижче.
     *
     * ВАЖЛИВО: this.state.get(група) поверне щось лише якщо offline_brightness/scenarios
     * КОЛИСЬ встановлювались через топік САМОЇ ГРУПИ (zigbee2mqtt/<group>/set),
     * а не через топік конкретного пристрою.
     */
    async syncNewMemberFromGroupState(groupName, endpointID, device) {
        const groupEntity = this.zigbee.resolveEntity(groupName);
        if (!groupEntity) {
            console.warn(`🌿 [AutoGrouper-BG] Групу "${groupName}" не вдалось резолвити для синхронізації.`);
            return;
        }

        const groupObject = groupEntity.group ?? groupEntity;

        const lastKnownState = this.state.get(groupObject);

        if (!lastKnownState || Object.keys(lastKnownState).length === 0) {
            console.log(
                `🌿 [AutoGrouper-BG] Немає відомого стану групи "${groupName}" — синхронізація пропущена.`,
            );
            return;
        }

        console.log(`🌿 [AutoGrouper-BG] Останні дані групи "${groupName}": ${JSON.stringify(lastKnownState)}`);

        // Беремо ендпоінт напряму з живого об'єкта пристрою, без повторного пошуку за іменем!
        const targetEndpoint = device.zh.getEndpoint(endpointID);
        if (!targetEndpoint) {
            console.warn(`🌿 [AutoGrouper-BG] Не вдалось отримати ендпоінт ${endpointID} для пристрою ${device.ieeeAddr}.`);
            return;
        }

        console.log(
            `🌿 [AutoGrouper-BG] Синхронізація "${device.name}" (EP${endpointID}) ` +
            `з відомим станом групи "${groupName}"...`,
        );

        try {
            // --- Стандартні on/off + рівень ---
            if (lastKnownState.state === 'OFF') {
                await targetEndpoint.command('genOnOff', 'off', {});
            } else if (lastKnownState.state === 'ON') {
                await targetEndpoint.command('genOnOff', 'on', {});
                if (typeof lastKnownState.brightness === 'number') {
                    await targetEndpoint.command('genLevelCtrl', 'moveToLevel', {
                        level: lastKnownState.brightness,
                        transtime: 0,
                    });
                }
            }

 // --- Кастомні атрибути каналу ---
            if (typeof lastKnownState.offline_brightness === 'number') {
                await targetEndpoint.write(CHANNEL_CLUSTER, {
                    0: {value: lastKnownState.offline_brightness, type: 0x20},
                });
            }

            if (lastKnownState.scenarios) {
                const scenariosArray = typeof lastKnownState.scenarios === 'string'
                    ? JSON.parse(lastKnownState.scenarios)
                    : lastKnownState.scenarios;
                const buffer = encodeScenarios(scenariosArray);
                await targetEndpoint.write(CHANNEL_CLUSTER, {
                    1: {value: buffer, type: 0x41},
                });
            }


            console.log(`🌿 [AutoGrouper-BG] Синхронізація каналу на EP${endpointID} завершена успішно!`);
        } catch (error) {
            console.error(`🌿 [AutoGrouper-BG] Помилка запису в ендпоінт при синхронізації: ${error.message}`);
        }
    }

    /**
     * Надсилає запит на створення групи й чекає підтвердження від бриджа.
     * Повертає true, якщо група вже існувала раніше (запит на створення
     * повернув помилку — найімовірніше "already exists"), і false,
     * якщо групу справді щойно створено.
     * Таймаут або будь-яка інша помилка теж трактується як true
     * (безпечний варіант: краще спробувати додати член у групу, що вже
     * може існувати, ніж помилково вважати її новою і пропустити синхронізацію).
     */
async ensureGroupExists(groupName, group_ID) {
        // =========================================================================
        // Локальна перевірка в пам'яті (БЕЗ MQTT-запиту і помилок у лозі)
        // =========================================================================
        const existingGroup = this.zigbee.resolveEntity(groupName) ?? this.zigbee.groupByID(group_ID);
        
        if (existingGroup && existingGroup.isGroup && existingGroup.isGroup()) {
            console.log(`🌿 [AutoGrouper-BG] Група "${groupName}" (ID: ${group_ID}) вже існує в базі Z2M.`);
            return true;
        }

        // =========================================================================
        // Якщо групи немає — створюємо її через MQTT
        // =========================================================================
        console.log(`🌿 [AutoGrouper-BG] Групу не знайдено. Створення "${groupName}"...`);

        const responsePromise = this.waitForBridgeResponse(
            'zigbee2mqtt/bridge/response/group/add',
            (payload) => {
                if (payload?.data?.id === group_ID || payload?.data?.friendly_name === groupName) return true;
                if (payload?.status === 'error' && typeof payload?.error === 'string' && payload.error.includes(groupName)) {
                    return true;
                }
                return false;
            },
            BRIDGE_RESPONSE_TIMEOUT_MS,
        );

        this.eventBus.emitMQTTMessage({
            topic: 'zigbee2mqtt/bridge/request/group/add',
            message: JSON.stringify({ friendly_name: groupName, id: group_ID }),
        });

        const response = await responsePromise;

        if (response?.status === 'ok') {
            console.log(`🌿 [AutoGrouper-BG] Групу "${groupName}" створено вперше.`);
            return false;
        }

        // Страховка на випадок колізії, якщо група була створена кимось паралельно
        console.log(`🌿 [AutoGrouper-BG] Відповідь бриджа: ${response?.status ?? 'timeout'}.`);
        return true;
    }

    /**
     * Одноразово чекає на MQTT-повідомлення бриджа, що відповідає предикату.
     * Використовує окремий "токен" контексту, щоб не конфліктувати з
     * постійними слухачами, зареєстрованими на `this` у start().
     */
    waitForBridgeResponse(topic, predicate, timeoutMs) {
        return new Promise((resolve) => {
            const token = {};
            let settled = false;

            const finish = (result) => {
                if (settled) return;
                settled = true;
                this.eventBus.removeListeners(token);
                resolve(result);
            };

            this.eventBus.onMQTTMessage(token, (data) => {
                if (data.topic !== topic) return;
                let payload;
                try {
                    payload = JSON.parse(data.message);
                } catch {
                    return;
                }
                if (!predicate(payload)) return;
                finish(payload);
            });

            setTimeout(() => finish(null), timeoutMs);
        });
    }
}

module.exports = AutoGrouper;   