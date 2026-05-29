/**
 * Greenhouse Auto Grouper Extension
 */
class AutoGrouper {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, settings, logger) {
        this.zigbee = zigbee;
        this.eventBus = eventBus;
        this.logger = logger;
    }

    start() {
        this.logger.info('🌿 Greenhouse Auto Grouper started!');
        this.onDeviceMessage = this.onDeviceMessage.bind(this);
        this.eventBus.on('deviceMessage', this.onDeviceMessage);
    }

    stop() {
        this.eventBus.removeListener('deviceMessage', this.onDeviceMessage);
    }

    // Використовуємо async, бо робота з групами в Z2M асинхронна
    async onDeviceMessage(data) {
        // data.device — це Z2M обгортка (Device wrapper)
        const device = data.device;

        if (!device || device.modelID !== 'Greenhouse_Controller_v1') return;

        // .zh — це доступ до низькорівневого zigbee-herdsman пристрою
        const zhDevice = device.zh;
        const basicEndpoint = zhDevice.getEndpoint(1);
        if (!basicEndpoint) return;

        const productLabel = basicEndpoint.clusters?.genBasic?.attributes?.productLabel;
        if (!productLabel) return;

        const dipVal = parseInt(productLabel, 10);
        if (isNaN(dipVal)) return;

        const channelEndpoints = zhDevice.endpoints.filter(ep => ep.ID > 1);

        for (const ep of channelEndpoints) {
            // Твоя формула
            const targetGroupId = (dipVal * 10) + ep.ID;

            // getGroupByID повертає Z2M обгортку (Group wrapper)
            let group = this.zigbee.getGroupByID(targetGroupId);

            if (!group) {
                const groupName = `Zone_${dipVal}_Ch_${ep.ID}`;
                this.logger.info(`🌿 Creating Z2M Group: ID ${targetGroupId} (${groupName})`);
                this.zigbee.createGroup(targetGroupId, groupName);
                group = this.zigbee.getGroupByID(targetGroupId);
            }

            // Використовуємо group.zh.hasMember, як в оригінальному ядрі
            if (group && !group.zh.hasMember(ep)) {
                this.logger.info(`🌿 Adding EP:${ep.ID} to Group ${targetGroupId}`);

                try {
                    // 1. Асинхронно додаємо ендпоінт до групи (через .zh)
                    await ep.addToGroup(group.zh);

                    // 2. СИГНАЛ ДЛЯ ІНТЕРФЕЙСУ (Взято з groups.ts)
                    // Саме це змусить Z2M негайно оновити вкладку Exposes
                    this.eventBus.emitGroupMembersChanged({
                        group: group,
                        action: 'add',
                        endpoint: ep,
                        skipDisableReporting: false
                    });

                } catch (error) {
                    this.logger.error(`🌿 Failed to add to group: ${error.message}`);
                }
            }
        }
    }
}

module.exports = AutoGrouper;