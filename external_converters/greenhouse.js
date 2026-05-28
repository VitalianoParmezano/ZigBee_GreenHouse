const m = require('zigbee-herdsman-converters/lib/modernExtend');

const definition = {
    zigbeeModel: ['Greenhouse_Controller_v1'], 
    model: 'Greenhouse_Controller_v1',
    vendor: 'ESV',
    description: 'Контролер теплиці (3 канали світла)',

    extend: [
        // 1. Мапимо системні цифри ендпоінтів з ESP32 на текстові аліаси
        m.deviceEndpoints({
            endpoints: { 'Green': 2, 'Red': 3, 'Blue': 4, 'info': 1 }
        }),
        
        // 2. Створюємо 3 канали регульованого світла (brightness: true)
        // Назви в endpointNames мають ТОЧНО збігатися з аліасами вище!
        m.light({
            endpointNames: ['Green', 'Red', 'Blue'], 
            brightness: true,
            effect: false,
            powerOnBehavior: false
        }),
        
        // 3. Читаємо текстовий атрибут "productLabel" з Basic Cluster на 1-му ендпоінті
        m.text({
            name: 'lamp_label',
            cluster: 'genBasic',
            attribute: 'productLabel',
            description: 'Мітка пристрою (EP 1)',
            access: 'STATE_GET', // Дозволяємо тільки зчитувати стан
            endpointName: 'info'
        }),
    ],
};

module.exports = definition;