const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const e = exposes.presets;
const ea = exposes.access;

const SYSTEM_CLUSTER = 0xFF01;
const CHANNEL_CLUSTER = 0xFC01;

const MODE_MAP = { 0: 'manual', 1: 'timer', 2: 'auto' };
const MODE_MAP_REVERSE = { manual: 0, timer: 1, auto: 2 };

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
        if (minute === 0 && brightness === 0 && i > 0) continue;
        scenarios.push({ time: minutesToTime(minute), brightness });
    }
    return scenarios;
}

function encodeScenarios(scenarios) {
    if (!Array.isArray(scenarios)) {
        throw new Error('scenarios має бути масивом об\'єктів {time, brightness}');
    }
    if (scenarios.length > MAX_SCENARIOS) {
        throw new Error(`Максимум ${MAX_SCENARIOS} сценаріїв на канал`);
    }
    const sorted = [...scenarios].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    const buffer = Buffer.alloc(sorted.length * BYTES_PER_SCENARIO);
    sorted.forEach((s, i) => {
        const minute = timeToMinutes(s.time);
        const brightness = Number(s.brightness);
        const offset = i * BYTES_PER_SCENARIO;
        buffer.writeUInt16LE(minute, offset);
        buffer.writeUInt8(brightness, offset + 2);
    });
    return buffer;
}

// fzLocal
const fzLocal = {
    system: {
        cluster: SYSTEM_CLUSTER.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            // Перевіряємо, що пакет прийшов з 2-го ендпоінта
            if (msg.endpoint.ID !== 2) return;

            const d = msg.data;
            const bootVal = d['0'] ?? d[0];
            if (bootVal !== undefined) result.boot_status = Number(bootVal);

            const modeVal = d['1'] ?? d[1];
            if (modeVal !== undefined) result.mode = MODE_MAP[modeVal] ?? 'unknown';

            const timeVal = d['2'] ?? d[2];
            if (timeVal !== undefined) result.device_time = minutesToTime(timeVal);

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

// tzLocal
const tzLocal = {
    boot_status: {
        key: ['boot_status'],
        convertSet: async(entity, key, value, meta) => {
            const endpoint = meta.device.getEndpoint(2); // Жорстко б'ємо в EP 2
            await endpoint.write(SYSTEM_CLUSTER, { 0: { value: Number(value), type: 0x20 } });
            return { state: { boot_status: Number(value) } };
        },
        convertGet: async(entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            await endpoint.read(SYSTEM_CLUSTER, [0]);
        },
    },

    mode: {
        key: ['mode'],
        convertSet: async(entity, key, value, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            const numeric = typeof value === 'string' ? MODE_MAP_REVERSE[value] : value;
            await endpoint.write(SYSTEM_CLUSTER, { 1: { value: numeric, type: 0x20 } });
            return { state: { mode: MODE_MAP[numeric] } };
        },
        convertGet: async(entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            await endpoint.read(SYSTEM_CLUSTER, [1]);
        },
    },

    device_time: {
        key: ['device_time'],
        convertSet: async(entity, key, value, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            const minutes = timeToMinutes(value);
            await endpoint.write(SYSTEM_CLUSTER, { 2: { value: minutes, type: 0x21 } });
            return { state: { device_time: value } };
        },
        convertGet: async(entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            await endpoint.read(SYSTEM_CLUSTER, [2]);
        },
    },

    offline_brightness: {
        key: ['offline_brightness'],
        convertSet: async(entity, key, value, meta) => {
            await entity.write(CHANNEL_CLUSTER, { 0: { value: Number(value), type: 0x20 } });
            return { state: { offline_brightness: Number(value) } };
        },
        convertGet: async(entity, key, meta) => {
            await entity.read(CHANNEL_CLUSTER, [0]);
        },
    },

    scenarios: {
        key: ['scenarios'],
        convertSet: async(entity, key, value, meta) => {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            const buffer = encodeScenarios(parsed);
            await entity.write(CHANNEL_CLUSTER, { 1: { value: buffer, type: 0x41 } });
            return { state: { scenarios: JSON.stringify(parsed) } };
        },
        convertGet: async(entity, key, meta) => {
            await entity.read(CHANNEL_CLUSTER, [1]);
        },
    },
};

function channelExposes(endpointName, label) {
    return [
        exposes.presets.light_brightness()
        .withEndpoint(endpointName)
        .withDescription(`Світло: ${label}`),

        exposes.presets.numeric('offline_brightness', exposes.access.ALL)
        .withValueMin(0)
        .withValueMax(100)
        .withEndpoint(endpointName)
        .withDescription(`Яскравість "${label}" за відсутності зв'язку`),

        exposes.presets.text('scenarios', exposes.access.ALL)
        .withEndpoint(endpointName)
        .withDescription(`Часові мітки "${label}"`),
    ];
}

const definition = {
    zigbeeModel: ['Greenhouse_Controller_v1'],
    model: 'Greenhouse_Controller_v1',
    vendor: 'ESV',
    description: 'Контролер освітлення теплиці з таймерними сценаріями по каналах',

    meta: { multiEndpoint: true },

    // ВИДАЛИЛИ 'system: 2' зв'язку з мульти-ендпоінтом! 
    // Тепер мапінг стосується лише каналів l1, l2, l3:
    endpoint: (device) => ({
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
        // БЕЗ .withEndpoint('system') -> Z2M опублікує їх БЕЗ суфіксів!
        e.numeric('boot_status', ea.ALL)
            .withDescription('0 = потрібна синхронізація, 1 = синхронізовано')
            .withValueMax(1)
            .withValueMin(0),

        e.enum('mode', ea.ALL, ['manual', 'timer', 'auto'])
            .withDescription('Режим роботи пристрою'),

        e.text('device_time', ea.ALL)
            .withDescription('Поточний час на пристрої, HH:MM'),

        ...channelExposes('l1', 'Канал 1'),
        ...channelExposes('l2', 'Канал 2'),
        ...channelExposes('l3', 'Канал 3'),
    ],
};

module.exports = definition;