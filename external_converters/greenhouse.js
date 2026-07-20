const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const e = exposes.presets;
const ea = exposes.access;

// ---------------------------------------------------------------------------
// Кластери
// ---------------------------------------------------------------------------
// УВАГА: у поточній прошивці системний кластер (EP2) ще лишається 0xFF01,
// тоді як канальний кластер (EP11-13) вже переведений на 0xFC01.
// 0xFF01 історично зарезервований під Xiaomi/Aqara-специфічний парсинг
// у zigbee-herdsman-converters, тож рекомендується перевести EP2 на 0xFC01
// теж, щоб уникнути потенційних конфліктів. Тут використані значення,
// які відповідають прошивці РІВНО ЗАРАЗ.
const SYSTEM_CLUSTER = 0xFF01; // TODO: перевести на 0xFC01, як у каналах
const CHANNEL_CLUSTER = 0xFC01;

// ---------------------------------------------------------------------------
// Мапінг режимів роботи
// ---------------------------------------------------------------------------
const MODE_MAP = {0: 'manual', 1: 'auto', 2: 'timer'};
const MODE_MAP_REVERSE = {manual: 0, auto: 1, timer: 2};

// ---------------------------------------------------------------------------
// Робота з часом
// ---------------------------------------------------------------------------
function minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMinutes(timeStr) {
    const parts = String(timeStr).split(':').map(Number);
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) {
        throw new Error(`Некоректний формат часу: ${timeStr} (очікується "HH:MM")`);
    }
    const [h, m] = parts;
    return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Пакування/розпакування бінарного розкладу (time_mark_t: uint16 LE + uint8)
// ---------------------------------------------------------------------------
const MAX_SCENARIOS = 12;
const BYTES_PER_SCENARIO = 3;

function decodeScenarios(buffer) {
    if (!Buffer.isBuffer(buffer)) return [];

    const count = Math.floor(buffer.length / BYTES_PER_SCENARIO);
    const scenarios = [];

    for (let i = 0; i < count; i++) {
        const offset = i * BYTES_PER_SCENARIO;
        const minute = buffer.readUInt16LE(offset);
        const brightness = buffer.readUInt8(offset + 2);

        // Незаповнені (нульові) мітки після реальних даних пропускаються.
        // Це евристика: якщо прошивка коректно оновлює довжину octet string
        // при кожному записі, цей фільтр стає зайвим, але лишається як
        // страховка на випадок застарілої довжини атрибута.
        if (minute === 0 && brightness === 0 && i > 0) continue;

        scenarios.push({time: minutesToTime(minute), brightness});
    }

    return scenarios;
}

function encodeScenarios(scenarios) {
    if (!Array.isArray(scenarios)) {
        throw new Error('scenarios має бути масивом об\'єктів {time, brightness}');
    }
    if (scenarios.length > MAX_SCENARIOS) {
        throw new Error(`Максимум ${MAX_SCENARIOS} сценаріїв на канал, отримано ${scenarios.length}`);
    }

    // Сортування за часом виконується на стороні Z2M перед відправкою,
    // щоб прошивка отримувала вже впорядкований масив і не сортувала сама
    const sorted = [...scenarios].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

    const buffer = Buffer.alloc(sorted.length * BYTES_PER_SCENARIO);

    sorted.forEach((s, i) => {
        const minute = timeToMinutes(s.time);
        const brightness = Number(s.brightness);

        if (minute < 0 || minute > 1439) {
            throw new Error(`Час поза межами доби: ${s.time}`);
        }
        if (Number.isNaN(brightness) || brightness < 0 || brightness > 100) {
            throw new Error(`Некоректна яскравість: ${s.brightness}`);
        }

        const offset = i * BYTES_PER_SCENARIO;
        buffer.writeUInt16LE(minute, offset);
        buffer.writeUInt8(brightness, offset + 2);
    });

    return buffer;
}

// ---------------------------------------------------------------------------
// fromZigbee: пристрій -> HA
// ---------------------------------------------------------------------------
const fzLocal = {
    system: {
        cluster: SYSTEM_CLUSTER.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            if (msg.data.hasOwnProperty('0')) {
                result.boot_status = msg.data['0'];
            }
            if (msg.data.hasOwnProperty('1')) {
                result.mode = MODE_MAP[msg.data['1']] ?? 'unknown';
            }
            if (msg.data.hasOwnProperty('2')) {
                result.device_time = minutesToTime(msg.data['2']);
            }

            return result;
        },
    },

    channel: {
        cluster: CHANNEL_CLUSTER.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            if (msg.data.hasOwnProperty('0')) {
                result.offline_brightness = msg.data['0'];
            }
            if (msg.data.hasOwnProperty('1')) {
                result.scenarios = JSON.stringify(decodeScenarios(msg.data['1']));
            }

            return result;
        },
    },
};

// ---------------------------------------------------------------------------
// toZigbee: HA -> пристрій
// ---------------------------------------------------------------------------
const tzLocal = {
    boot_status: {
        key: ['boot_status'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write(SYSTEM_CLUSTER, {0: {value: Number(value), type: 0x20}}); // uint8
            return {state: {boot_status: Number(value)}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(SYSTEM_CLUSTER, [0]);
        },
    },

    mode: {
        key: ['mode'],
        convertSet: async (entity, key, value, meta) => {
            const numeric = typeof value === 'string' ? MODE_MAP_REVERSE[value] : value;
            if (numeric === undefined) {
                throw new Error(`Невідомий режим: ${value} (очікується manual/auto/timer)`);
            }
            await entity.write(SYSTEM_CLUSTER, {1: {value: numeric, type: 0x20}}); // uint8
            return {state: {mode: MODE_MAP[numeric]}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(SYSTEM_CLUSTER, [1]);
        },
    },

    device_time: {
        key: ['device_time'],
        convertSet: async (entity, key, value, meta) => {
            // value приходить у форматі "HH:MM" (зазвичай від періодичної
            // автоматизації HA, а не від ручного вводу користувача)
            const minutes = timeToMinutes(value);
            await entity.write(SYSTEM_CLUSTER, {2: {value: minutes, type: 0x21}}); // uint16
            return {state: {device_time: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(SYSTEM_CLUSTER, [2]);
        },
    },

    offline_brightness: {
        key: ['offline_brightness'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write(CHANNEL_CLUSTER, {0: {value: Number(value), type: 0x20}}); // uint8
            return {state: {offline_brightness: Number(value)}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(CHANNEL_CLUSTER, [0]);
        },
    },

    scenarios: {
        key: ['scenarios'],
        convertSet: async (entity, key, value, meta) => {
            // value приходить як JSON-рядок:
            // [{"time":"07:30","brightness":80}, {"time":"19:00","brightness":20}]
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            const buffer = encodeScenarios(parsed);
            await entity.write(CHANNEL_CLUSTER, {1: {value: buffer, type: 0x41}}); // Octet String
            return {state: {scenarios: JSON.stringify(parsed)}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(CHANNEL_CLUSTER, [1]);
        },
    },
};

// ---------------------------------------------------------------------------
// Визначення пристрою
// ---------------------------------------------------------------------------
function channelExposes(endpointName, label) {
    return [
        e.light_brightness().withEndpoint(endpointName).withDescription(`Світло: ${label}`),
        e.numeric('offline_brightness', ea.ALL)
            .withValueMin(0).withValueMax(100)
            .withEndpoint(endpointName)
            .withDescription(`Яскравість "${label}" за відсутності зв'язку`),
        e.text('scenarios', ea.ALL)
            .withEndpoint(endpointName)
            .withDescription(
                `Сценарії "${label}", JSON-масив: [{"time":"07:30","brightness":80}]`,
            ),
    ];
}

const definition = {
    zigbeeModel: ['Greenhouse_Controller_v1'],
    model: 'Greenhouse_Controller_v1',
    vendor: 'ESV',
    description: 'Контролер освітлення теплиці з таймерними сценаріями по каналах',

    meta: {multiEndpoint: true},

    endpoint: (device) => ({
        system: 2,
        l1: 11,
        l2: 12,
        l3: 13,
    }),

    fromZigbee: [fzLocal.system, fzLocal.channel, fz.on_off, fz.brightness],
    toZigbee: [
        tzLocal.boot_status,
        tzLocal.mode,
        tzLocal.device_time,
        tzLocal.offline_brightness,
        tzLocal.scenarios,
        tz.light_onoff_brightness,
    ],

    exposes: [
        e.numeric('boot_status', ea.ALL)
            .withEndpoint('system')
            .withDescription('0 = потрібна синхронізація, 1 = синхронізовано (пишеться HA після хендшейку)'),

        e.enum('mode', ea.ALL, ['manual', 'auto', 'timer'])
            .withEndpoint('system')
            .withDescription('Режим роботи пристрою'),

        e.text('device_time', ea.ALL)
            .withEndpoint('system')
            .withDescription('Поточний час на пристрої, HH:MM (періодично пишеться автоматизацією HA)'),

        ...channelExposes('l1', 'Канал 1'),
        ...channelExposes('l2', 'Канал 2'),
        ...channelExposes('l3', 'Канал 3'),
    ],
};

module.exports = definition;
