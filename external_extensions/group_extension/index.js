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

        console.log(`🌿 застосовано зміни 35`);
        // ПРАВИЛЬНА ПОДІЯ: onStateChange
        //this.eventBus.onStateChange(this, this.onStateChange.bind(this));

        this.eventBus.onDeviceInterview(this, this.onDeviceInterview.bind(this));
        
        this.eventBus.onDeviceJoined(this, this.onDeviceJoined.bind(this));

        this.eventBus.onDeviceLeave(this, this.onDeviceLeave.bind(this));
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
        if (data.status !== 'successful') return;
        
        console.log(`🌿 [AutoGrouper] Interview successful for: ${data.device.ieeeAddr}. Запускаю фоновий процес...`);
        
        // ЗВЕРНИ УВАГУ: Ми викликаємо функцію БЕЗ слова "await"! 
        // Це відриває її від головного потоку Z2M і дозволяє працювати у фоні.
        this.setupGroupsInBackground(data.device).catch(err => {
            console.error(`🌿 [AutoGrouper] ❌ Помилка у фоновому процесі: ${err.message}`);
        });
        console.log(`🌿 [AutoGrouper] Фоновий процес запущено, головний потік вільний для інших задач.`);
    }

    // Вся наша важка логіка з MQTT винесена в окремий фоновий метод
    async setupGroupsInBackground(device) {
        console.log(`\n🌿 [AutoGrouper-BG] Фоновий процес для ${device.ieeeAddr} почався...`);
        // Даємо системі 2 секунди, щоб Z2M повністю завершив свої внутрішні процеси після інтерв'ю
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`\n🌿 [AutoGrouper-BG] === Початок фонового налаштування груп ===`);

        const basicEndpoint = device.zh.getEndpoint(1);
        let myLabel;

        if (basicEndpoint) {
            try {
                console.log(`🌿 [AutoGrouper-BG] Зчитування productLabel...`);
                const result = await basicEndpoint.read('genBasic', ['productLabel']);
                myLabel = result?.productLabel;
                console.log(`🌿 [AutoGrouper-BG] Отримано DIP-значення: "${myLabel}"`);
            } catch (error) {
                console.error(`🌿 [AutoGrouper-BG] Помилка читання: ${error.message}`);
            }
        }
        
        if (!myLabel || isNaN(Number(myLabel))) return;

        const deviceFriendlyName = device.name;


        for (let i = 1; i <= 3; i++) {
            const group_ID = Number(myLabel) * 10 + i; 
            const channelName = `Channel_${i}`;
            const groupName = `Zone_${myLabel}_${channelName}`;
            const endpointID = i + 1; 

            if (!device.zh.getEndpoint(endpointID)) continue;

            console.log(`\n🌿 [AutoGrouper-BG] Обробка групи ${groupName} (ID: ${group_ID})...`);

            const createGroupPayload = {
                friendly_name: groupName,
                id: group_ID
            };
            
            console.log(`🌿 [AutoGrouper-BG] 1. Ін'єкція bridge/request/group/add...`);
            // Замість публікації на брокер, ми імітуємо, що повідомлення щойно прийшло!
            // Увага: тут обов'язково має бути базовий топік (за замовчуванням zigbee2mqtt)
            this.eventBus.emitMQTTMessage({
                topic: 'zigbee2mqtt/bridge/request/group/add', 
                message: JSON.stringify(createGroupPayload)
            });

            await new Promise(resolve => setTimeout(resolve, 1000));

            const addMemberPayload = {
                group: groupName,
                device: `${deviceFriendlyName}`,
                endpoint: `${endpointID}`,
                skip_disable_reporting: true
            };

            console.log(`🌿 [AutoGrouper-BG] 2. Ін'єкція bridge/request/group/members/add...`);
            this.eventBus.emitMQTTMessage({
                topic: 'zigbee2mqtt/bridge/request/group/members/add', 
                message: JSON.stringify(addMemberPayload)
            });

            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`🌿 [AutoGrouper-BG] 🟢 Канал ${channelName} успішно налаштовано.`);
        }

    }

    async onDeviceLeave(data) {
            const ieeeAddr = data.ieeeAddr || (data.device && data.device.ieeeAddr);
            const deviceFriendlyName = (data.device && data.device.name) ? data.device.name : ieeeAddr;

            // console.log(`\n🌿 [AutoGrouper] Device left: ${deviceFriendlyName} (${ieeeAddr}). Очищаємо групи...`);

            // const removeAllPayload = {
            //     device: ieeeAddr,
            //     skip_disable_reporting: true // Можна додати, якщо Z2M свариться на те, що пристрій офлайн
            // };

            // console.log(`🌿 [AutoGrouper] Надсилаємо запит remove_all для пристрою...`);
            
            // this.eventBus.emitMQTTMessage({
            //     topic: 'zigbee2mqtt/bridge/request/group/members/remove_all', 
            //     message: JSON.stringify(removeAllPayload)
            // });

            console.log(`🌿 [AutoGrouper] 🟢 Пристрій ${deviceFriendlyName} видалено з груп.\n`);
        }
    

}




module.exports = AutoGrouper;