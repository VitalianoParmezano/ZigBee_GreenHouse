/**
 * Greenhouse Auto Grouper Extension
 * Версія на базі подій StateChange
 */
class AutoGrouper {
    // Нам знадобиться об'єкт state, щоб читати поточний стан пристрою
    constructor(zigbee, _2, state, _4, eventBus) {
        this.zigbee = zigbee;
        this.eventBus = eventBus;
        this.state = state; 
    }

    start() {
        console.log('🌿 [AutoGrouper] STARTED. Listening for state changes...');

        console.log(`🌿 застосовано зміни 12`);
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

        if (basicEndpoint) {
            try {
                console.log(`🌿 [AutoGrouper] Надсилаю радіозапит на зчитування productLabel...`);

                // 2. Викликаємо метод .read(Кластер, [МасивАтрибутів])
                // Ця команда змушує координатор відправити сирий Zigbee-пакет у повітря
                const result = await basicEndpoint.read('genBasic', ['productLabel']);

                // 3. Результат повертається у вигляді простісінького об'єкта
                console.log(`🌿 [AutoGrouper] Результат зчитування:`, result);
                
                const myLabel = result?.productLabel;
                console.log(`🌿 [AutoGrouper] Значення атрибута: "${myLabel}"`);

            } catch (error) {
                // Якщо пристрій спить або вимкнений — запит скинеться по таймауту
                console.error(`🌿 [AutoGrouper] Помилка читання з ефіру: ${error.message}`);
            }
        }
        


        
        

        console.log(`🌿 [AutoGrouper] =======================================\n`);
    }
}



module.exports = AutoGrouper;