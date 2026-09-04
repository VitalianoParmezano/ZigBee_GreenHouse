const exposes = require('zigbee-herdsman-converters/lib/exposes');
const e = exposes.presets;
const ea = exposes.access;

// Пристрій пише в стандартний ZCL-кластер msIlluminanceMeasurement, атрибут
// measuredValue, за формулою стандарту: measuredValue = 10000 × log10(lux) + 1.
// Декодування зроблено вручну (той самий підхід, що й fzLocal.system/channel
// у greenhouse_controller.js), а не через fz.illuminance чи modernExtend
// illuminance() - ці іменовані експорти між версіями zigbee-herdsman-converters
// нестабільні (illuminance переносили з fromZigbee у modernExtend і назад),
// тоді як назва самого кластера - частина специфікації ZCL і не змінюється.
const fzLocal = {
    illuminance: {
        cluster: 'msIlluminanceMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const raw = msg.data.measuredValue;
            if (raw === undefined) return;
            const lux = Math.pow(10, (raw - 1) / 10000);
            return { illuminance: Math.round(lux * 100) / 100 };
        },
    },
};

// zigbeeModel нижче - ПЛЕЙСХОЛДЕР, як і раніше. Точне значення береться з
// самої плати після спарювання: сторінка "Unsupported devices" у Z2M або
// топік zigbee2mqtt/bridge/devices, поле modelID.
const definition = {
    zigbeeModel: ['GreenHouse_LightSensor'],
    model: 'GreenHouse_LightSensor',
    vendor: 'ESV',
    description: 'Датчик освітленості (ESP32-H2), стандартний illuminance-кластер',

    fromZigbee: [fzLocal.illuminance],
    toZigbee: [],

    exposes: [
        e.numeric('illuminance', ea.STATE)
            .withUnit('lx')
            .withDescription('Виміряна освітленість'),
    ],
};

module.exports = definition;