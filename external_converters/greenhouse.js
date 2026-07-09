const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const e = exposes.presets;
const ea = exposes.access;

// Використовуємо числове значення для кастомного кластера
const CUSTOM_CLUSTER = 0xFF01;

// Конвертер: Отримання даних від пристрою (From Zigbee to MQTT)
const fLocal = {
    greenhouse_custom_data: {
        cluster: CUSTOM_CLUSTER.toString(), // Для fLocal z2m очікує рядок
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            // 0x0000: Статус завантаження (DIP-світч)
            if (msg.data.hasOwnProperty('0')) {
                result.boot_status = msg.data['0'];
            }

            // 0x0001: Поточний режим роботи (0 - Manual, 1 - Auto, 2 - Timer)
            if (msg.data.hasOwnProperty('1')) {
                const modeMap = { 0: 'Manual', 1: 'Auto', 2: 'Timer' };
                result.current_mode = modeMap[msg.data['1']];
            }

            // 0x0002: Значення яскравості офлайн
            if (msg.data.hasOwnProperty('2')) {
                result.offline_brightness = msg.data['2'];
            }

            // 0x0003: Бінарний масив розкладу (Octet String)
            if (msg.data.hasOwnProperty('3')) {
                const buffer = msg.data['3'];
                if (Buffer.isBuffer(buffer)) {
                    // Перетворюємо бінарні дані у HEX-рядок для відображення в MQTT / HA
                    result.timer_data = buffer.toString('hex');
                }
            }

            return result;
        },
    },
};

// Конвертер: Відправлення даних на пристрій (From MQTT to Zigbee)
const tLocal = {
    greenhouse_custom_data: {
        key: ['boot_status', 'current_mode', 'offline_brightness', 'timer_data'],
        convertSet: async(entity, key, value, meta) => {
            // ЖОРСТКО направляємо команди кастомного кластера на 2-й ендпоінт
            const endpoint = meta.device.getEndpoint(2);

            if (!endpoint) {
                throw new Error("Ендпоінт 2 не знайдено на пристрої! Перевірте логіку C-коду.");
            }

            if (key === 'boot_status') {
                await endpoint.write(CUSTOM_CLUSTER, { 0: { value: value, type: 0x20 } }); // 0x20 = uint8
            }
            if (key === 'current_mode') {
                const modeMap = { 'Manual': 0, 'Auto': 1, 'Timer': 2 };
                // Перевірка, щоб обробити як текстове значення ('Auto'), так і числове (1)
                const val = typeof value === 'string' ? modeMap[value] : value;
                await endpoint.write(CUSTOM_CLUSTER, { 1: { value: val, type: 0x20 } });
            }
            if (key === 'offline_brightness') {
                await endpoint.write(CUSTOM_CLUSTER, { 2: { value: value, type: 0x20 } });
            }
            if (key === 'timer_data') {
                // Перетворюємо HEX-рядок з MQTT назад у бінарний буфер для відправки по Zigbee
                const buffer = Buffer.from(value, 'hex');
                await endpoint.write(CUSTOM_CLUSTER, { 3: { value: buffer, type: 0x41 } }); // 0x41 = Octet String
            }

            // Повертаємо стан для оновлення в інтерфейсі Z2M / HA
            return {
                state: {
                    [key]: value
                }
            };
        },
        convertGet: async(entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            const lookup = {
                'boot_status': 0,
                'current_mode': 1,
                'offline_brightness': 2,
                'timer_data': 3
            };
            if (endpoint) {
                await endpoint.read(CUSTOM_CLUSTER, [lookup[key]]);
            }
        },
    },
};

// Головне визначення пристрою
const definition = {
    zigbeeModel: ['Greenhouse_Controller_v1'],
    model: 'Greenhouse_Controller_v1',
    vendor: 'ESV',
    description: 'Контролер для теплиці',

    // Вмикаємо підтримку мультиендпоінтів
    meta: { multiEndpoint: true },

    // Вказуємо відповідність логічних назв ендпоінтів та їх фізичних номерів на ESP32
    endpoint: (device) => {
        return {
            system: 2, // Ендпоінт з нашим кастомним кластером (DIP, режими)
            l1: 11, // Зона 1, канал 1
            l2: 12, // Зона 1, канал 2
            l3: 13, // Зона 2, канал 1 (додайте більше за потреби)
        };
    },

    fromZigbee: [fLocal.greenhouse_custom_data, fz.on_off, fz.brightness],
    toZigbee: [tLocal.greenhouse_custom_data, tz.light_onoff_brightness],

    exposes: [
        // --- Кастомні налаштування (Ендпоінт 2 -> system) ---
        e.numeric('boot_status', ea.ALL)
        .withEndpoint('system')
        .withDescription('Статус завантаження DIP'),

        e.enum('current_mode', ea.ALL, ['Manual', 'Auto', 'Timer'])
        .withEndpoint('system')
        .withDescription('Поточний режим роботи'),

        e.numeric('offline_brightness', ea.ALL)
        .withValueMin(0).withValueMax(100)
        .withEndpoint('system')
        .withDescription('Яскравість без зв\'язку'),

        e.text('timer_data', ea.ALL)
        .withEndpoint('system')
        .withDescription('Розклад таймерів (HEX рядок)'),

        // --- Канали освітлення (Ендпоінти 11, 12, 13 -> l1, l2, l3) ---
        e.light_brightness().withEndpoint('l1').withDescription('Світло Зона 1 Канал 1'),
        e.light_brightness().withEndpoint('l2').withDescription('Світло Зона 1 Канал 2'),
        e.light_brightness().withEndpoint('l3').withDescription('Світло Зона 2 Канал 1'),
    ],
};

module.exports = definition;