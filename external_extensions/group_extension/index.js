/**

Версія не робоча,
не можна з середини екстеншину
відправляти MQTT запити 
(це зроблено для запобігання циклічним залежностям та багам у Z2M)

 */
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

        console.log(`🌿 застосовано зміни 28`);
        // ПРАВИЛЬНА ПОДІЯ: onStateChange
        //this.eventBus.onStateChange(this, this.onStateChange.bind(this));

        this.eventBus.onDeviceInterview(this, this.onDeviceInterview.bind(this));
        
        this.eventBus.onDeviceJoined(this, this.onDeviceJoined.bind(this));

        this.eventBus.onDeviceConfigure
    }


    stop() {
        this.eventBus.removeListeners(this);
        console.log('🌿 [AutoGrouper] STOPPED.');
    }


async onDeviceJoined(data) {
    const device = data.device;

    console.log(`🌿 [AutoGrouper] Device joined: ${data.device.ieeeAddr}`);

}    


async onDeviceInterview(data) {

        if (data.status !== 'successful') {
            console.log(`🌿 [AutoGrouper] Device interview event: status: ${data.status}. Skipping...`);
            return;
        }
        

        console.log(`🌿 [AutoGrouper] Device interview event: status: ${data.status}. Processing...`);
        
        const device = data.device;

        // Перевірка моделі (на етапі successful вона вже точно є)

        console.log(`\n🌿 [AutoGrouper] =======================================`);
        console.log(`🌿 [AutoGrouper] 🎯 Interview successful for: ${device.ieeeAddr}`);
        console.log(`🌿 [AutoGrouper] 🔍 Model: ${device.zh.modelID}`);


        // 1. Отримуємо низькорівневий ендпоінт 1
        const basicEndpoint = device.zh.getEndpoint(1);
        var myLabel;

        if (basicEndpoint) {
            try {
                console.log(`🌿 [AutoGrouper] Надсилаю радіозапит на зчитування productLabel...`);

                // 2. Викликаємо метод .read(Кластер, [МасивАтрибутів])
                // Ця команда змушує координатор відправити сирий Zigbee-пакет у повітря
                const result = await basicEndpoint.read('genBasic', ['productLabel']);

                // 3. Результат повертається у вигляді простісінького об'єкта
                console.log(`🌿 [AutoGrouper] Результат зчитування:`, result);
                
                myLabel = result?.productLabel;
                console.log(`🌿 [AutoGrouper] Значення атрибута: "${myLabel}"`);

            } catch (error) {
                // Якщо пристрій спить або вимкнений — запит скинеться по таймауту
                console.error(`🌿 [AutoGrouper] Помилка читання з ефіру: ${error.message}`);
            }
        }
        

        const endpoints = device.zh.endpoints; 
        console.log(`🌿 [AutoGrouper] Виявлено ендпоінтів: ${endpoints.length}`);
        console.log(`🌿 [AutoGrouper] Список ендпоінтів: ${endpoints.map(ep => ep.ID).join(', ')}`);


        // Замість жорсткого циклу 1..3, ітеруємося по реальних ендпоінтах пристрою
        // (якщо вам потрібні лише перші 3 канали, можна обмежити index < 3)
        for (let i = 0; i < Math.min(endpoints.length); i++) {
            const endpoint = endpoints[i];
            const endpointID = endpoint.ID;
            
            console.log(`\n🌿 [AutoGrouper] Перевіряємо ендпоінт ID: ${endpointID}...`);
            // Пропускаємо ендпоінт координатора або специфічні службові ендпоінти (наприклад, GreenPower)
            if (endpointID === 242 || endpointID === 0 || endpointID === 1) continue;

            const channelNumber = i + 1; // Для назви каналу (1, 2, 3)
            const group_ID = Number(myLabel) * 10 + channelNumber; 
            const channelName = `l${channelNumber}`;
            const groupName = `Zone_${myLabel}_${channelName}`;

            console.log(`\n🌿 [AutoGrouper] === Обробка групи ${groupName} (ID: ${group_ID}) ===`);

            // ==========================================
            // КРОК 1: Створення групи
            // ==========================================
            const createGroupPayload = {
                friendly_name: groupName,
                id: group_ID
            };
            
            console.log(`🌿 [AutoGrouper] 1. Надсилаємо запит на створення групи...`);
            this.eventBus.emit('mqttMessage', {
                topic: 'bridge/request/group/add',
                message: JSON.stringify({ friendly_name: groupName, id: String(group_ID) })
            });

            
            console.log(`🌿 [AutoGrouper] Осьтакйи запит відправлено: \n ${JSON.stringify(createGroupPayload)}`);


            // Чекаємо фіксації групи в базі даних Z2M
            await new Promise(resolve => setTimeout(resolve, 600));

            // ==========================================
            // КРОК 2: Додавання через IEEE-адресу (надійніше ніж Friendly Name)
            // ==========================================
            const addMemberPayload = {
                group: groupName,
                device: `${device.ieeeAddr}/${endpointID}`, // IEEE адрес гарантує відсутність багів із символами
                skip_disable_reporting: true
            };

    console.log(`🌿 [AutoGrouper] 2. Додаємо девайс ${device.ieeeAddr} (EP: ${endpointID}) у групу...`);
    this.mqtt.publish(
        'bridge/request/group/members/add', 
        JSON.stringify(addMemberPayload)
    );

    // Пауза перед наступним пристроєм, щоб не забити Zigbee-ефір командами
    await new Promise(resolve => setTimeout(resolve, 800));
    console.log(`🌿 [AutoGrouper] 🟢 Завершено для каналу ${channelName}.`);
}

        // for (let i = 1; i <= 3; i++) {
        //     const group_ID = Number(myLabel) * 10 + i; 
        //     const channelName = `l${i}`;
        //     const groupName = `Zone_${myLabel}_${channelName}`;
        //     const endpointID = i + 1; 

        //     // Перевіряємо, чи існує такий ендпоінт фізично
        //     if (!device.zh.getEndpoint(endpointID)) continue;

        //     console.log(`\n🌿 [AutoGrouper] === Обробка групи ${groupName} (ID: ${group_ID}) ===`);

        //     // ==========================================
        //     // КРОК 1: Створюємо групу через MQTT Bridge
        //     // ==========================================
        //     const createGroupPayload = {
        //         friendly_name: groupName,
        //         id: group_ID
        //     };
            
        //     console.log(`🌿 [AutoGrouper] 1. Надсилаємо запит на створення групи...`);
        //     this.mqtt.publish(
        //         'zigbee2mqtt/bridge/request/group/add', 
        //         JSON.stringify(createGroupPayload)
        //     );

        //     // Даємо ядру Z2M пів секунди на запис у базу database.db та configuration.yaml
        //     // Це важливо, бо MQTT-запити асинхронні!
        //     await new Promise(resolve => setTimeout(resolve, 500));

        //     // ==========================================
        //     // КРОК 2: Додаємо ендпоінт у групу через MQTT Bridge
        //     // ==========================================
        //     const addMemberPayload = {
        //         group: groupName,
        //         // Формат звернення до ендпоінта: "НазваПристрою/НомерЕндпоінта"
        //         device: `${deviceFriendlyName}/${endpointID}`,
        //         skip_disable_reporting: true
        //     };

        //     console.log(`🌿 [AutoGrouper] 2. Додаємо ендпоінт ${endpointID} у групу...`);
        //     this.mqtt.publish(
        //         'zigbee2mqtt/bridge/request/group/members/add', 
        //         JSON.stringify(addMemberPayload)
        //     );

        //     // Даємо ще трохи часу на обробку перед наступною ітерацією циклу
        //     await new Promise(resolve => setTimeout(resolve, 500));
        //     console.log(`🌿 [AutoGrouper] 🟢 Завершено для каналу ${channelName}.`);
        // }

        
        
        

        console.log(`🌿 [AutoGrouper] =======================================\n`);
    }
}



module.exports = AutoGrouper;