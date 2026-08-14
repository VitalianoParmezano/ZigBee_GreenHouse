/**
 * Розширення автоматично створює групи для кожного каналу пристрою на основі
 * productLabel (значення DIP-перемикача).
 *
 * Після успішного інтерв'ю нового пристрою запускається фоновий процес:
 * productLabel зчитується з пристрою, і для кожного каналу створюється (або
 * знаходиться вже існуюча) група. Якщо група вже існувала, ендпоінт нового
 * члена синхронізується з останнім відомим станом групи (this.state.get),
 * включно з кастомними атрибутами offline_brightness і scenarios, а не лише
 * on/off та яскравістю. Цей кеш містить кастомні атрибути лише тоді, коли
 * ними керували через топік самої групи (zigbee2mqtt/<group>/set) - якщо
 * через топік окремого пристрою, значення кешуються під пристроєм, і
 * синхронізація тут їх не побачить.
 *
 * TODO: очищення груп при виході пристрою з мережі ще не реалізоване.
 *
 * У Zigbee2MQTT 2.11+ зовнішні розширення завантажуються лише з увімкненим
 * advanced.enable_external_js, і документація описує їх у форматі .mjs (ESM).
 * Цей файл лишається в CommonJS-форматі - перед розгортанням на Z2M 2.x
 * варто перевірити конвертацію на export default / .mjs.
 */
const SHIFT = 10; // зміщення ендпоінтів каналів, налаштовується також на пристрої
const NUMBER_OF_CHANNELS = 3; // кількість каналів на пристрої
const BRIDGE_RESPONSE_TIMEOUT_MS = 3000;
const CHANNEL_CLUSTER = 0xFC01; // кастомний кластер offline_brightness/scenarios на кожному каналі
const MAX_SCENARIOS = 12;
const BYTES_PER_SCENARIO = 3;

/*
    Тут звернути увагу.
    Цей параметр визначає зміщення зони
    Наприклад якщо стоїть 1, тоді до значення product_label яке зчитується 
    з пристрою для визначення його зони (і в подальшому для призначення його в відповідну групу) додається 1.
        Використовувати у випадках коли наприклад діп свіч на 3 піни, розрахований що можна ним
    вказати 8 унікальних значень (включно з нулем), але для кінцевого користувача Zone_0... не 
    припустимо, для цього робиться оффсет
*/
const ZONES_OFFSET = 1;

const LOGIC_SERVICE_PREFIX = 'LogicService'; // окремий канал для картки, не плутати з zigbee2mqtt/bridge/*
const HEARTBEAT_TIMEOUT_MS = 100_000; // пінг очікується раз на 50-70с, тому 100с - запас на один пропущений цикл

// Ці функції пакування дублюють ті, що в external converter - варто тримати
// їх синхронізованими або перенести в спільний модуль при розростанні логіки.
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
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.eventBus = eventBus;
        this.state = state;

        // Стан heartbeat-моніторингу тримається окремо від груп/каналів
        this.deviceZones = new Map();        // ieeeAddr -> номер зони, кешується один раз при налаштуванні
        this.zoneLookupInFlight = new Map(); // ieeeAddr -> Promise, дедуплікує паралельні read() при частих пінгах
        this.heartbeatTimers = new Map();    // ieeeAddr -> handle таймера очікування наступного пінгу
        this.deviceOnlineState = new Map();  // ieeeAddr -> 'online' | 'offline', заповнюється лише після першої події
    }

    start() {
        console.log('🌿 [AutoGrouper] STARTED. Listening for state changes...');

        this.eventBus.onDeviceInterview(this, this.onDeviceInterview.bind(this));
        this.eventBus.onDeviceJoined(this, this.onDeviceJoined.bind(this));

        this.eventBus.onStateChange(this, this.onStateChange.bind(this));

        // Grace-таймери озброюються для всіх вже відомих пристроїв одразу при старті/рестарті
        // розширення. Без цього кроку плата, що замовкла ще до рестарту, ніколи не отримає
        // свій перший пінг, і її offline-таймер просто ніколи не буде запущено - вона застрягне
        // у невизначеному стані замість того, щоб бути позначеною офлайн протягом 100с.
        this._armGraceTimersForKnownDevices();
    }

    stop() {
        this.eventBus.removeListeners(this);

        // Усі heartbeat-таймери прибираються, інакше вони спрацюють у "порожнечу"
        // вже після зупинки розширення (посилання на стару this-обгортку залишиться в пам'яті)
        for (const timer of this.heartbeatTimers.values()) {
            clearTimeout(timer);
        }
        this.heartbeatTimers.clear();

        console.log('🌿 [AutoGrouper] STOPPED.');
    }

    async onDeviceJoined(data) {
        console.log(`🌿 [AutoGrouper] Device joined: ${data.device.ieeeAddr}`);
    }

    // Обробка результату інтерв'ю після приєднання нового пристрою
    async onDeviceInterview(data) {
        if (data.status !== 'successful') return;

        console.log(`🌿 [AutoGrouper] Interview successful for: ${data.device.ieeeAddr}. Запускаю фоновий процес...`);

        this.setupDevicesInBackground(data.device).catch((err) => {
            console.error(`🌿 [AutoGrouper] ❌ Помилка у фоновому процесі: ${err.message}`);
        });
        console.log(`🌿 [AutoGrouper] Процес налаштування пристрою ${data.device} запущено.`);
    }

    // data містить: { entity (об'єкт пристрою/групи), from, to, update (змінені поля) }
    async onStateChange(data) {
        if (!data.entity || data.entity.isGroup()) return;

        // Пінг (серцебиття) ловиться тут - мікроконтролером надсилається 2, очікується підтвердження зв'язку
        if (data.update && data.update.boot_status === 2) {
            await this._handleHeartbeatPing(data.entity);
            return;
        }
    }

    /**
     * Обробляється кожен вхідний пінг від пристрою.
     * Понг надсилається негайно. Паралельно перезапускається персональний
     * таймер очікування наступного пінгу - якщо новий пінг не прийде за
     * HEARTBEAT_TIMEOUT_MS, пристрій вважається офлайн.
     * Якщо пристрій до цього вважався офлайн - надсилається сповіщення
     * про повернення в LogicService/bridge/request.
     */
    async _handleHeartbeatPing(device) {
        const ieeeAddr = device.ieeeAddr;

        console.log(`🌿 [Heartbeat] Пінг отримано від ${device.name}. Понг надсилається...`);

        // Понг надсилається через внутрішню шину MQTT, минаючи зовнішній брокер напряму -
        // повідомлення проходить через tz-конвертер і безпечно записується в ESP32
        this.eventBus.emitMQTTMessage({
            topic: `zigbee2mqtt/${device.name}/set`,
            message: JSON.stringify({ boot_status: 1 }),
        });

        // Попередній таймер очікування скасовується і озброюється новий
        const existingTimer = this.heartbeatTimers.get(ieeeAddr);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
            this._markDeviceOffline(device).catch((err) => {
                console.error(`🌿 [Heartbeat] Помилка позначення "${device.name}" офлайн: ${err.message}`);
            });
        }, HEARTBEAT_TIMEOUT_MS);
        this.heartbeatTimers.set(ieeeAddr, timer);

        // Сповіщення про повернення в мережу надсилається лише при переході
        // зі стану 'offline' - на звичайних регулярних пінгах нічого не публікується,
        // щоб не спамити картку однаковими подіями кожні 50-70с
        const wasOffline = this.deviceOnlineState.get(ieeeAddr) === 'offline';
        this.deviceOnlineState.set(ieeeAddr, 'online');

        if (wasOffline) {
            const zone = await this._resolveZone(device);
            console.log(`🌿 [Heartbeat] "${device.name}" повернувся в мережу (зона ${zone}).`);
            this._publishDeviceStatus(zone, device.name, 'online');
        }
    }

    /**
     * Викликається таймером, коли новий пінг не прийшов вчасно.
     * Подвійне спрацювання блокується перевіркою поточного стану.
     */
    async _markDeviceOffline(device) {
        const ieeeAddr = device.ieeeAddr;

        if (this.deviceOnlineState.get(ieeeAddr) === 'offline') return;

        this.deviceOnlineState.set(ieeeAddr, 'offline');
        this.heartbeatTimers.delete(ieeeAddr);

        const zone = await this._resolveZone(device);
        console.warn(`🌿 [Heartbeat] Пінг від "${device.name}" не отримано за ${HEARTBEAT_TIMEOUT_MS / 1000}с - позначається офлайн (зона ${zone}).`);
        this._publishDeviceStatus(zone, device.name, 'offline');
    }

    /**
     * Публікується сповіщення про статус пристрою в окремий канал картки.
     * Топік НЕ перетинається з внутрішнім zigbee2mqtt/bridge/* API самого Z2M.
     */
    _publishDeviceStatus(zone, deviceName, status) {
        this.eventBus.emitMQTTMessage({
            topic: `${LOGIC_SERVICE_PREFIX}/bridge/request`,
            message: JSON.stringify({ zone, device: deviceName, status }),
        });
    }

    /**
     * Номер зони визначається з кешу, заповненого під час onDeviceInterview/setupDevicesInBackground.
     * Якщо кешу ще немає (наприклад, перший пінг долетів раніше фонового налаштування,
     * або розширення було перезапущене без повторного інтерв'ю пристрою) - зона читається
     * напряму з пристрою через ту саму атрибуту productLabel, що й при первинному налаштуванні.
     * Паралельні виклики для одного пристрою дедуплікуються через zoneLookupInFlight.
     */
    async _resolveZone(device) {
        const ieeeAddr = device.ieeeAddr;

        if (this.deviceZones.has(ieeeAddr)) {
            return this.deviceZones.get(ieeeAddr);
        }

        if (this.zoneLookupInFlight.has(ieeeAddr)) {
            return this.zoneLookupInFlight.get(ieeeAddr);
        }

        const lookupPromise = (async () => {
            try {
                const basicEndpoint = device.zh.getEndpoint(1);
                if (!basicEndpoint) return null;

                const result = await basicEndpoint.read('genBasic', ['productLabel']);
                const zone = Number(result?.productLabel);
                if (isNaN(zone)) return null;

                this.deviceZones.set(ieeeAddr, zone);
                return zone;
            } catch (error) {
                console.error(`🌿 [Heartbeat] Зону для "${device.name}" визначити не вдалось: ${error.message}`);
                return null;
            } finally {
                this.zoneLookupInFlight.delete(ieeeAddr);
            }
        })();

        this.zoneLookupInFlight.set(ieeeAddr, lookupPromise);
        return lookupPromise;
    }

    /**
     * При старті (чи рестарті) розширення для кожного вже відомого сумісного пристрою
     * озброюється стартовий таймер очікування. Пінг від пристрою, якщо він живий,
     * скасує цей таймер і замінить його звичайним rolling-таймером у _handleHeartbeatPing.
     * Якщо пристрій мовчав ще до рестарту - через HEARTBEAT_TIMEOUT_MS він коректно
     * позначиться офлайн, а не зависне у невизначеному стані назавжди.
     */
    _armGraceTimersForKnownDevices() {
        let devices = [];

        if (typeof this.zigbee.getClients === 'function') {
            devices = this.zigbee.getClients();
        } else if (typeof this.zigbee.devices === 'function') {
            devices = this.zigbee.devices();
        } else if (this.zigbee.devices && typeof this.zigbee.devices === 'object') {
            devices = Object.values(this.zigbee.devices);
        } else {
            console.error('🌿 [Heartbeat] Спосіб отримання списку пристроїв у цій версії Z2M не знайдено - стартові таймери не озброєні.');
            return;
        }

        let armedCount = 0;
        for (const device of devices) {
            if (!device || !device.zh || device.zh.type === 'Coordinator') continue;
            if (!device.zh.getEndpoint(2)) continue; // системного ендпоінта немає - пристрій не наш

            const timer = setTimeout(() => {
                this._markDeviceOffline(device).catch((err) => {
                    console.error(`🌿 [Heartbeat] Помилка стартової перевірки "${device.name}": ${err.message}`);
                });
            }, HEARTBEAT_TIMEOUT_MS);

            this.heartbeatTimers.set(device.ieeeAddr, timer);
            armedCount++;
        }

        console.log(`🌿 [Heartbeat] Стартові таймери озброєно для ${armedCount} пристроїв.`);
    }

    async setupDevicesInBackground(device) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        console.log(`\n🌿 [AutoGrouper-BG] === Налаштування груп ===`);

        const basicEndpoint = device.zh.getEndpoint(1);
        let myLabel = 0;

        if (basicEndpoint) {
        try {
                console.log(`🌿 [AutoGrouper-BG] Зчитування productLabel...`);
                const result = await basicEndpoint.read('genBasic', ['productLabel']);
                myLabel = Number(result?.productLabel || 0) + ZONES_OFFSET;
                console.log(`🌿 [AutoGrouper-BG] productLabel == ${myLabel}`);
            } catch (error) {
                console.error(`🌿 [AutoGrouper-BG] Помилка читання: ${error.message}`);
            }
        }

        if (!myLabel || isNaN(Number(myLabel))) return;

        //myLabel += 1;
        // Зона кешується одразу - подальші пінги від цього пристрою більше не
        // потребуватимуть окремого Zigbee-читання productLabel у _resolveZone()
        this.deviceZones.set(device.ieeeAddr, Number(myLabel));

        const deviceFriendlyName = device.name;

        // Системні метадані пристрою (EP2) синхронізуються перед роботою з каналами:
        // відновлюється режим (mode), час (device_time), виставляється boot_status = 1
        await this.syncNewMemberFromDeviceState(device);

        for (let i = 1; i <= NUMBER_OF_CHANNELS; i++) {
            const group_ID = Number(myLabel) * 10 + i;
            const channelName = `Channel_${i}`;
            const groupName = `Zone_${myLabel}_${channelName}`;
            const endpointID = i + SHIFT;

            if (!device.zh.getEndpoint(endpointID)) continue;

            console.log(`\n🌿 [AutoGrouper-BG] Обробка групи ${groupName} (ID: ${group_ID})...`);

            const groupAlreadyExisted = await this.ensureGroupExists(groupName, group_ID);

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

            // Якщо група вже існувала - новий член синхронізується з останнім
            // відомим станом групи, а не якогось довільного пристрою
            if (groupAlreadyExisted) {
                await this.syncNewMemberFromGroupState(groupName, endpointID, device);
            } else {
                console.log(`🌿 [AutoGrouper-BG] Група щойно створена, немає відомого стану для синхронізації.`);
            }

            console.log(`🌿 [AutoGrouper-BG] Канал ${channelName} успішно налаштовано.`);
        }

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
     * Синхронізуються системні налаштування пристрою в цілому (ендпоінт 2):
     * режим роботи (mode), поточний час та статус завантаження.
     * @param {Object} device - об'єкт пристрою з zigbee-herdsman
     */
    async syncNewMemberFromDeviceState(device) {
        const SYSTEM_CLUSTER = 0xFF01;
        const MODE_MAP_REVERSE = { manual: 0, timer: 1, auto: 2 };

        // Ендпоінт 2 містить системні атрибути (mode, boot_status, device_time)
        const metadataEndpoint = device.zh.getEndpoint(2);
        if (!metadataEndpoint) {
            console.warn(`🌿 [AutoGrouper-BG] ❌ Не вдалось отримати EP2 (System) для пристрою ${device.ieeeAddr}.`);
            return;
        }

        const lastKnownState = this.state.get(device) || {};
        console.log(`🌿 [AutoGrouper-BG] Останні відомі системні дані пристрою ${device.ieeeAddr}:`, JSON.stringify(lastKnownState));

        // Цільовий режим береться зі збереженого в кеші, або 'manual' за замовчуванням для нових плат
        const targetModeStr = lastKnownState.mode || 'manual';
        const targetModeNum = MODE_MAP_REVERSE[targetModeStr] ?? 2; // 2 = auto

        console.log(`🌿 [AutoGrouper-BG] Синхронізація плати "${device.name}" -> Режим: "${targetModeStr}" (${targetModeNum})...`);

        try {
            await metadataEndpoint.write(SYSTEM_CLUSTER, {
                1: { value: targetModeNum, type: 0x20 } // 0x20 = uint8
            });
            console.log(`🌿 [AutoGrouper-BG] ✓ Режим "${targetModeStr}" успішно записано в пристрій ${device.ieeeAddr}.`);

            // Час поки що не записується напряму в атрибут - обробку часу виконує конвертер
            this.eventBus.emitMQTTMessage({
                topic: `zigbee2mqtt/${device.ieeeAddr}/set`,
                message: JSON.stringify({ device_time: 0 }),
            });

            console.log(`🌿 [AutoGrouper-BG] Синхронізація метаданних для "${device.name}" завершена успішно!`);
        } catch (error) {
            console.error(`🌿 [AutoGrouper-BG] Помилка запису в системний ендпоінт EP2: ${error.message}`);
        }
    }

    /**
     * Синхронізується щойно доданий член групи з останнім відомим станом групи.
     *
     * this.zigbee.resolveEntity(name) - недокументоване внутрішнє API, точна форма
     * повернутого об'єкта може відрізнятись між версіями Z2M. Перед деплоєм варто
     * один раз вивести console.log(JSON.stringify(Object.keys(groupEntity))) і за
     * потреби підправити groupEntity.group / groupEntity нижче.
     *
     * this.state.get(група) поверне щось лише якщо offline_brightness/scenarios
     * колись встановлювались через топік самої групи (zigbee2mqtt/<group>/set),
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

        // Ендпоінт береться напряму з живого об'єкта пристрою, без повторного пошуку за іменем
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
     * Надсилається запит на створення групи, і очікується підтвердження від бриджа.
     * Повертається true, якщо група вже існувала раніше (запит на створення
     * повернув помилку - найімовірніше "already exists"), і false, якщо групу
     * справді щойно створено. Таймаут або будь-яка інша помилка теж трактується
     * як true - безпечніше спробувати додати член у групу, що вже може існувати,
     * ніж помилково вважати її новою і пропустити синхронізацію.
     */
    async ensureGroupExists(groupName, group_ID) {
        // Локальна перевірка в пам'яті, без MQTT-запиту і помилок у лозі
        const existingGroup = this.zigbee.resolveEntity(groupName) ?? this.zigbee.groupByID(group_ID);

        if (existingGroup && existingGroup.isGroup && existingGroup.isGroup()) {
            console.log(`🌿 [AutoGrouper-BG] Група "${groupName}" (ID: ${group_ID}) вже існує в базі Z2M.`);
            this.enableGroupRetain(group_ID);
            return true;
        }

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
            this.enableGroupRetain(group_ID);
            return false;
        }

        // Страховка на випадок колізії, якщо група була створена паралельно
        console.log(`🌿 [AutoGrouper-BG] Відповідь бриджа: ${response?.status ?? 'timeout'}.`);
        return true;
    }

    /**
     * Вмикається retain для групи через MQTT API Zigbee2MQTT
     */
    enableGroupRetain(group_ID) {
        console.log(`🌿 [AutoGrouper-BG] Відправка запиту на увімкнення retain для групи ID: ${group_ID}...`);

        this.eventBus.emitMQTTMessage({
            topic: 'zigbee2mqtt/bridge/request/group/options',
            message: JSON.stringify({
                id: group_ID,
                options: {
                    retain: true
                }
            }),
        });
    }

    /**
     * Очікується одноразове MQTT-повідомлення бриджа, що відповідає предикату.
     * Використовується окремий "токен" контексту, щоб не конфліктувати з
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