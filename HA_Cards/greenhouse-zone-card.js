/// ---------------------------------------------------------------------------
// GreenhouseZoneCard - керує зонами/каналами через LogicService (не напряму
// через zigbee2mqtt і не через HA-сутності). Весь обмін даними - MQTT:
//
//   LogicService/Zone_x_Channel_y            <- retained, повний стан каналу
//                                                (mode, scenarios, brightness, state)
//   LogicService/Zone_x_Channel_y/set        -> запис (mode/scenarios/brightness)
//   LogicService/Zone_x_Channel_y/get        -> запит стану (не критичний для
//                                                картки - retained-топік вище
//                                                вже дає актуальний стан одразу
//                                                при підписці)
//   LogicService/bridge/request              <- сповіщення про online/offline
//                                                конкретного пристрою:
//                                                {zone, device, status}
//
// mode - ОДИН НА ВСЮ ЗОНУ (усі CHANNELS_PER_ZONE каналів мають однаковий
// режим одночасно). Це UI-рівнева інваріанта: клік по пілюлі режиму
// публікує {mode: ...} в /set КОЖНОГО каналу зони одразу. scenarios
// лишається per-channel. Офлайн-режим (offline_brightness) прибрано з
// системи повністю - картка про нього більше нічого не знає.
//
// Синхронізація між картками: КОЖЕН відкритий екземпляр картки (на будь-якому
// пристрої/вкладці) незалежно підписується на LogicService/+ через
// hass.connection.subscribeMessage - тому зміна в одній картці (чи навіть
// напряму з LogicService при спрацюванні таймера) миттєво долітає до всіх
// інших відкритих карток без жодного опитування/polling.
// ---------------------------------------------------------------------------

const ZONES = 6;
const CHANNELS_PER_ZONE = 3;
const SCENARIO_SLOTS = 12;
const CONTROL_PREFIX = 'LogicService';
const SCENARIO_CLIPBOARD_KEY = 'greenhouseScenarioClipboardV1';

// ---------------------------------------------------------------------------
// Утиліти
// ---------------------------------------------------------------------------
function groupName(zone, channel) {
    return `Zone_${zone}_Channel_${channel}`;
}

function parseGroupName(name) {
    const m = /^Zone_(\d+)_Channel_(\d+)$/.exec(name);
    if (!m) return null;
    return { zone: Number(m[1]), channel: Number(m[2]) };
}

function safeParseScenarios(rawValue) {
    if (!rawValue) return [];
    if (Array.isArray(rawValue)) return rawValue;
    try {
        const parsed = JSON.parse(rawValue);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function clampPercent(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
}

const DEFAULT_CHANNEL_STATE = { mode: 'manual', scenarios: [], brightness: 0, state: 'OFF' };

class GreenhouseZoneCard extends HTMLElement {

    constructor() {
        super();
        this._mqttSubscribed = false;
        this._unsubMqtt = null;
        this._unsubBridgeRequest = null;
        // Zone_x_Channel_y -> { mode, scenarios, brightness, state }
        // Наповнюється ЛИШЕ з LogicService/+ (retained стан + живі оновлення).
        this._channelState = {};
        // device (ieee-адреса) -> { zone, device, status: 'offline' }
        // Персистентний список ПОТОЧНО офлайн-пристроїв - не залежить від
        // того, чи закрив оператор спливаючий тост. Очищується лише коли
        // прийде повідомлення status: 'online' для того самого device.
        this._offlineDevices = {};
        this._toastStackRoot = null;
        this._offlineListModalRoot = null;
    }

    setConfig(config) {
        this.config = config || {};
    }

    getGridOptions() {
        return {
            columns: 36,
            rows: 8,
            min_columns: 3,
            max_columns: 36,
        };
    }

    getCardSize() {
        return 4;
    }

    set hass(hass) {
        this._hass = hass;

        if (!this._mqttSubscribed && this._hass && this._hass.connection) {
            this._mqttSubscribed = true;
            this._subscribeToMqtt();
        }

        if (!this.content) {
            this._buildBaseLayout();
        }

        this._updateZoneStatuses();

        if (this._modalState && this._modalState.open) {
            this._refreshModalLiveValues();
        }
    }

    // -------------------------------------------------------------------
    // MQTT: стан каналів + повідомлення про online/offline пристроїв
    // -------------------------------------------------------------------
    async _subscribeToMqtt() {
        try {
            this._unsubMqtt = await this._hass.connection.subscribeMessage(
                (message) => this._onLogicServiceMessage(message),
                { type: 'mqtt/subscribe', topic: `${CONTROL_PREFIX}/+` }
            );
        } catch (err) {
            console.error('[GreenhouseZoneCard] Не вдалось підписатись на MQTT:', err);
            this._mqttSubscribed = false; // дозволяємо повторну спробу при наступному set hass()
        }

        try {
            this._unsubBridgeRequest = await this._hass.connection.subscribeMessage(
                (message) => this._onBridgeRequestMessage(message),
                { type: 'mqtt/subscribe', topic: `${CONTROL_PREFIX}/bridge/request` }
            );
        } catch (err) {
            console.error('[GreenhouseZoneCard] Не вдалось підписатись на bridge/request:', err);
        }
    }

    _onLogicServiceMessage(message) {
        const prefix = `${CONTROL_PREFIX}/`;
        if (!message.topic.startsWith(prefix)) return;

        const group = message.topic.slice(prefix.length);
        // Цікавить лише LogicService/<group> (без /set, /get, і без bridge/*,
        // де є "/") - саме там лежить повний стан каналу.
        if (group.includes('/')) return;

        let parsed;
        try {
            parsed = JSON.parse(message.payload);
        } catch {
            return;
        }

        this._channelState[group] = parsed;
        this._updateZoneStatuses();

        if (!this._modalState || !this._modalState.open) return;

        const { zone, activeChannel } = this._modalState;
        const info = parseGroupName(group);
        if (!info || info.zone !== zone) return;

        // mode спільний на всю зону - зміна БУДЬ-ЯКОГО каналу цієї зони
        // могла стосуватись режиму, тож пілюлі оновлюємо завжди.
        this._renderModeRow();

        if (info.channel === activeChannel) {
            this._refreshChannelSpecificValues();
        }
    }

    // { zone, device, status: 'offline' | 'online' }
    _onBridgeRequestMessage(message) {
        let data;
        try {
            data = JSON.parse(message.payload);
        } catch {
            console.warn('[GreenhouseZoneCard] Некоректний JSON у bridge/request:', message.payload);
            return;
        }

        const { zone, device, status } = data || {};
        if (!device || (status !== 'offline' && status !== 'online')) return;

        if (status === 'offline') {
            this._offlineDevices[device] = { zone, device, status: 'offline' };
        } else {
            delete this._offlineDevices[device];
        }

        this._showToast(status, zone, device);
        this._updateOfflineBadge();
    }

    _getChannelState(zone, channel) {
        return this._channelState[groupName(zone, channel)] || DEFAULT_CHANNEL_STATE;
    }

    async _publishSet(zone, channel, payload) {
        if (!this._hass) return;
        const topic = `${CONTROL_PREFIX}/${groupName(zone, channel)}/set`;
        try {
            await this._hass.callService('mqtt', 'publish', {
                topic,
                payload: JSON.stringify(payload),
            });
        } catch (err) {
            console.error(`[GreenhouseZoneCard] Помилка публікації в ${topic}:`, err);
        }
    }

    // mode - ОДИН на всю зону: публікуємо в /set КОЖНОГО каналу зони.
    _setZoneMode(zone, newMode) {
        for (let ch = 1; ch <= CHANNELS_PER_ZONE; ch++) {
            this._publishSet(zone, ch, { mode: newMode });
            const cfg = this._getChannelState(zone, ch);
            this._channelState[groupName(zone, ch)] = { ...cfg, mode: newMode };
        }
        this._renderModeRow();
        this._renderModalBody();
    }

    // -------------------------------------------------------------------
    // Побудова базового шаблону картки (виконується один раз)
    // -------------------------------------------------------------------
    _buildBaseLayout() {
        this.innerHTML = `
      <style>
        :host {
            display: block;
            height: 100%;
        }

        ha-card {
            background: none !important;
            border: none !important;
            box-shadow: none !important;
            display: flex !important;
            flex-direction: column;
            height: 100%;
            padding: 0;
            box-sizing: border-box;
            position: relative;
        }

        .grid-container {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            grid-template-rows: repeat(2, 1fr);
            gap: 12px;
            flex: 1;
            padding: 12px;
            box-sizing: border-box;
        }

        .zone-cell {
            min-height: 120px;
            background: rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
            border-radius: 16px;

            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;

            color: var(--primary-text-color);
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .zone-cell:hover {
            background: rgba(255, 255, 255, 0.12);
        }

        .zone-icon {
            --mdc-icon-size: 48px;
            color: grey;
            transition: color 0.3s ease;
            margin-bottom: 24px;
        }

        .zone-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .zone-status {
            font-size: 14px;
            opacity: 0.6;
        }

        .gh-offline-badge {
            position: absolute;
            top: 10px;
            right: 10px;
            display: none;
            align-items: center;
            gap: 4px;
            background: rgba(244, 67, 54, 0.15);
            border: 1px solid rgba(244, 67, 54, 0.4);
            color: #f44336;
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            z-index: 10;
        }
        .gh-offline-badge ha-icon {
            --mdc-icon-size: 16px;
        }
      </style>

      <ha-card>
        <div class="gh-offline-badge" id="gh-offline-badge">
            <ha-icon icon="mdi:wifi-off"></ha-icon>
            <span id="gh-offline-count">0</span>
        </div>
        <div class="grid-container" id="grid"></div>
      </ha-card>
    `;

        this.content = this.querySelector('#grid');

        for (let i = 1; i <= ZONES; i++) {
            const cell = document.createElement('div');
            cell.className = 'zone-cell';
            cell.innerHTML = `
                <ha-icon class="zone-icon" id="zone-${i}-icon" icon="mdi:sprout"></ha-icon>
                <div class="zone-title">Зона ${i}</div>
                <div class="zone-status" id="zone-${i}-val">Офлайн</div>
            `;

            cell.addEventListener('click', () => this._openZoneModal(i));
            this.content.appendChild(cell);
        }

        this.querySelector('#gh-offline-badge').addEventListener('click', () => this._openOfflineListModal());
        this._updateOfflineBadge();
    }

    // -------------------------------------------------------------------
    // Оновлення міток стану на плитках зон (за станом каналу 1 кожної зони)
    // -------------------------------------------------------------------
    _updateZoneStatuses() {
        for (let i = 1; i <= ZONES; i++) {
            const iconEl = this.querySelector(`#zone-${i}-icon`);
            const statusEl = this.querySelector(`#zone-${i}-val`);
            if (!iconEl || !statusEl) continue;

            const cfg = this._getChannelState(i, 1);
            const isOn = cfg.state === 'ON';
            statusEl.textContent = isOn ? `Увімкнено · ${cfg.brightness}%` : 'Вимкнено';
            iconEl.style.color = isOn ? '#4caf50' : 'grey';
        }
    }

    // -------------------------------------------------------------------
    // Тости про online/offline пристроїв - fixed-position стек, живе в
    // document.body (не всередині картки), щоб бути видимим завжди,
    // незалежно від скролу/розміщення картки на дашборді. Тост зникає
    // ЛИШЕ по кліку на хрестик - жодного авто-приховування, щоб оператор
    // гарантовано побачив сповіщення.
    // -------------------------------------------------------------------
    _ensureToastStack() {
        if (this._toastStackRoot) return this._toastStackRoot;

        const root = document.createElement('div');
        root.innerHTML = `
            <style>
                .gh-toast-stack {
                    position: fixed;
                    top: 16px;
                    right: 16px;
                    z-index: 1000000;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    max-width: 320px;
                }
                .gh-toast {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    padding: 12px 14px;
                    border-radius: 12px;
                    background: var(--card-background-color, #1c1c1c);
                    color: var(--primary-text-color);
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    animation: gh-toast-in 0.2s ease;
                }
                @keyframes gh-toast-in {
                    from { opacity: 0; transform: translateX(20px); }
                    to { opacity: 1; transform: translateX(0); }
                }
                .gh-toast-offline { border-left: 3px solid #f44336; }
                .gh-toast-online { border-left: 3px solid #4caf50; }
                .gh-toast-icon ha-icon { --mdc-icon-size: 22px; }
                .gh-toast-offline .gh-toast-icon { color: #f44336; }
                .gh-toast-online .gh-toast-icon { color: #4caf50; }
                .gh-toast-text { flex: 1; }
                .gh-toast-title { font-size: 13px; font-weight: 600; }
                .gh-toast-sub { font-size: 12px; opacity: 0.7; margin-top: 2px; }
                .gh-toast-close {
                    background: none;
                    border: none;
                    color: var(--primary-text-color);
                    opacity: 0.6;
                    cursor: pointer;
                    font-size: 14px;
                    line-height: 1;
                    padding: 2px;
                }
                .gh-toast-close:hover { opacity: 1; }
            </style>
            <div class="gh-toast-stack" id="gh-toast-stack"></div>
        `;
        document.body.appendChild(root);
        this._toastStackRoot = root;
        return root;
    }

    _showToast(status, zone, device) {
        const root = this._ensureToastStack();
        const stack = root.querySelector('#gh-toast-stack');
        const isOffline = status === 'offline';

        const toast = document.createElement('div');
        toast.className = `gh-toast gh-toast-${isOffline ? 'offline' : 'online'}`;
        toast.innerHTML = `
            <div class="gh-toast-icon"><ha-icon icon="${isOffline ? 'mdi:wifi-off' : 'mdi:wifi-check'}"></ha-icon></div>
            <div class="gh-toast-text">
                <div class="gh-toast-title">${isOffline ? 'Пристрій офлайн' : "Зв'язок відновлено"}</div>
                <div class="gh-toast-sub">Зона ${zone} · ${device}</div>
            </div>
            <button class="gh-toast-close">✕</button>
        `;

        toast.querySelector('.gh-toast-close').addEventListener('click', () => toast.remove());
        stack.appendChild(toast);
    }

    // -------------------------------------------------------------------
    // Бейдж-лічильник офлайн-пристроїв на картці + модалка зі списком.
    // Бейдж лишається видимим, навіть якщо оператор закрив усі тости -
    // єдиний спосіб його прибрати - щоб прийшло status: 'online'.
    // -------------------------------------------------------------------
    _updateOfflineBadge() {
        const badge = this.querySelector('#gh-offline-badge');
        const countEl = this.querySelector('#gh-offline-count');
        if (!badge || !countEl) return;

        const count = Object.keys(this._offlineDevices).length;
        countEl.textContent = String(count);
        badge.style.display = count > 0 ? 'flex' : 'none';

        if (this._offlineListModalRoot) {
            this._renderOfflineListModalBody();
        }
    }

    _openOfflineListModal() {
        const overlay = document.createElement('div');
        overlay.className = 'gh-modal-overlay';

        overlay.innerHTML = `
            <style>
                .gh-modal-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.65);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 999999;
                    backdrop-filter: blur(4px);
                    -webkit-backdrop-filter: blur(4px);
                }
                .gh-modal-box {
                    background: var(--card-background-color, #1c1c1c);
                    color: var(--primary-text-color);
                    border-radius: 16px;
                    width: min(420px, 92vw);
                    max-height: 80vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .gh-modal-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 16px 20px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .gh-modal-title { font-size: 18px; font-weight: 600; }
                .gh-modal-close {
                    background: none;
                    border: none;
                    color: var(--primary-text-color);
                    font-size: 20px;
                    cursor: pointer;
                    opacity: 0.7;
                    line-height: 1;
                    padding: 4px;
                }
                .gh-modal-close:hover { opacity: 1; }
                .gh-offline-list-body {
                    padding: 12px 20px 20px 20px;
                    overflow-y: auto;
                }
                .gh-offline-list-empty {
                    padding: 30px 10px;
                    text-align: center;
                    opacity: 0.6;
                    font-size: 14px;
                }
                .gh-offline-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px 0;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                }
                .gh-offline-item:last-child { border-bottom: none; }
                .gh-offline-item ha-icon { color: #f44336; --mdc-icon-size: 20px; }
                .gh-offline-item-text { flex: 1; }
                .gh-offline-item-zone { font-size: 14px; font-weight: 600; }
                .gh-offline-item-device { font-size: 12px; opacity: 0.6; font-family: monospace; }
            </style>
            <div class="gh-modal-box">
                <div class="gh-modal-header">
                    <div class="gh-modal-title">Офлайн-пристрої</div>
                    <button class="gh-modal-close" id="gh-offline-modal-close">✕</button>
                </div>
                <div class="gh-offline-list-body" id="gh-offline-list-body"></div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._closeOfflineListModal();
        });

        document.body.appendChild(overlay);
        this._offlineListModalRoot = overlay;
        overlay.querySelector('#gh-offline-modal-close').addEventListener('click', () => this._closeOfflineListModal());

        this._renderOfflineListModalBody();
    }

    _closeOfflineListModal() {
        if (this._offlineListModalRoot) {
            this._offlineListModalRoot.remove();
            this._offlineListModalRoot = null;
        }
    }

    _renderOfflineListModalBody() {
        if (!this._offlineListModalRoot) return;
        const body = this._offlineListModalRoot.querySelector('#gh-offline-list-body');
        const items = Object.values(this._offlineDevices);

        if (items.length === 0) {
            body.innerHTML = `<div class="gh-offline-list-empty">Немає офлайн-пристроїв</div>`;
            return;
        }

        body.innerHTML = items
            .map((item) => `
                <div class="gh-offline-item">
                    <ha-icon icon="mdi:wifi-off"></ha-icon>
                    <div class="gh-offline-item-text">
                        <div class="gh-offline-item-zone">Зона ${item.zone}</div>
                        <div class="gh-offline-item-device">${item.device}</div>
                    </div>
                </div>
            `)
            .join('');
    }

    // -------------------------------------------------------------------
    // Модальне вікно зони
    // -------------------------------------------------------------------
    _openZoneModal(zone) {
        this._modalState = { open: true, zone, activeChannel: 1 };

        const overlay = document.createElement('div');
        overlay.className = 'gh-modal-overlay';
        overlay.id = 'gh-modal-overlay';

        // Стилі модалки вставляються прямо в оверлей - overlay живе в document.body,
        // поза Shadow DOM картки, тож глобальні стилі сюди не дістануть самі.
        overlay.innerHTML = `
            <style>
                .gh-modal-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.65);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 999999;
                    backdrop-filter: blur(4px);
                    -webkit-backdrop-filter: blur(4px);
                }
                .gh-modal-box {
                    background: var(--card-background-color, #1c1c1c);
                    color: var(--primary-text-color);
                    border-radius: 16px;
                    width: min(560px, 92vw);
                    max-height: 88vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .gh-modal-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 16px 20px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .gh-modal-title {
                    font-size: 18px;
                    font-weight: 600;
                }
                .gh-modal-close {
                    background: none;
                    border: none;
                    color: var(--primary-text-color);
                    font-size: 20px;
                    cursor: pointer;
                    opacity: 0.7;
                    line-height: 1;
                    padding: 4px;
                }
                .gh-modal-close:hover { opacity: 1; }
                .gh-mode-row, .gh-tabs-row {
                    display: flex;
                    gap: 8px;
                    padding: 12px 20px 0 20px;
                }
                .gh-pill {
                    flex: 1;
                    text-align: center;
                    padding: 8px 10px;
                    border-radius: 999px;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    background: rgba(255, 255, 255, 0.05);
                    color: var(--primary-text-color);
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .gh-pill.active {
                    background: var(--primary-color, #03a9f4);
                    border-color: var(--primary-color, #03a9f4);
                    color: white;
                    font-weight: 600;
                }
                .gh-tabs-row { padding-top: 10px; }
                .gh-tabs-row .gh-pill { border-radius: 10px; }
                .gh-modal-body {
                    padding: 16px 20px 20px 20px;
                    overflow-y: auto;
                    flex: 1;
                }
                .gh-section-title {
                    font-size: 13px;
                    opacity: 0.6;
                    margin: 14px 0 8px 0;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .gh-section-title:first-child { margin-top: 0; }
                .gh-field-row {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin-bottom: 10px;
                }
                .gh-field-label {
                    flex: 0 0 120px;
                    font-size: 13px;
                    opacity: 0.8;
                }
                .gh-field-row input[type="range"] { flex: 1; }
                .gh-field-row input[type="number"] {
                    width: 70px;
                    padding: 6px 8px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                }
                .gh-toggle-btn {
                    padding: 6px 14px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                    cursor: pointer;
                }
                .gh-toggle-btn.on {
                    background: #4caf50;
                    border-color: #4caf50;
                    color: white;
                }
                .gh-scenario-row {
                    display: grid;
                    grid-template-columns: 24px 1fr 90px;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 6px;
                }
                .gh-scenario-index {
                    font-size: 12px;
                    opacity: 0.5;
                    text-align: right;
                }
                .gh-scenario-row input[type="number"] {
                    padding: 6px 8px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                    width: 100%;
                    box-sizing: border-box;
                }
                .gh-time-input {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    padding: 4px 6px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    box-sizing: border-box;
                }
                .gh-time-part {
                    width: 28px;
                    padding: 4px 0;
                    border: none;
                    background: transparent;
                    color: var(--primary-text-color);
                    font-size: 16px;
                    font-variant-numeric: tabular-nums;
                    text-align: center;
                    box-sizing: border-box;
                }
                .gh-time-part:focus {
                    outline: none;
                    background: rgba(255, 255, 255, 0.12);
                    border-radius: 4px;
                }
                .gh-time-part::-webkit-outer-spin-button,
                .gh-time-part::-webkit-inner-spin-button {
                    -webkit-appearance: none;
                    margin: 0;
                }
                .gh-time-sep {
                    opacity: 0.6;
                    font-size: 16px;
                }
                .gh-btn-row {
                    display: flex;
                    gap: 8px;
                    margin-top: 14px;
                }
                .gh-btn-row .gh-save-btn { margin-top: 0; flex: 2; }
                .gh-secondary-btn {
                    flex: 1;
                    padding: 10px;
                    border-radius: 10px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    cursor: pointer;
                }
                .gh-secondary-btn:active { opacity: 0.85; }
                .gh-save-btn {
                    margin-top: 14px;
                    width: 100%;
                    padding: 10px;
                    border-radius: 10px;
                    border: none;
                    background: var(--primary-color, #03a9f4);
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                }
                .gh-save-btn:active { opacity: 0.85; }
                .gh-hint {
                    font-size: 12px;
                    opacity: 0.55;
                    margin-top: 8px;
                }
                .gh-auto-placeholder {
                    padding: 40px 10px;
                    text-align: center;
                    opacity: 0.6;
                    font-size: 15px;
                }
            </style>
            <div class="gh-modal-box">
                <div class="gh-modal-header">
                    <div class="gh-modal-title">Керування — Зона ${zone}</div>
                    <button class="gh-modal-close" id="gh-modal-close">✕</button>
                </div>

                <div class="gh-mode-row" id="gh-mode-row"></div>
                <div class="gh-tabs-row" id="gh-tabs-row"></div>

                <div class="gh-modal-body" id="gh-modal-body"></div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._closeModal();
        });

        document.body.appendChild(overlay);
        this._modalRoot = overlay;

        overlay.querySelector('#gh-modal-close').addEventListener('click', () => this._closeModal());

        this._escHandler = (e) => {
            if (e.key === 'Escape') this._closeModal();
        };
        document.addEventListener('keydown', this._escHandler);

        this._renderModeRow();
        this._renderTabsRow();
        this._renderModalBody();
    }

    _closeModal() {
        if (this._modalRoot) {
            this._modalRoot.remove();
            this._modalRoot = null;
        }
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        this._modalState = null;
    }

    // mode - ОДИН на всю зону: читаємо стан каналу 1 (усі канали мають
    // збігатись), клік по пілюлі застосовує режим одразу на КОЖЕН канал зони.
    _renderModeRow() {
        const { zone } = this._modalState;
        const cfg = this._getChannelState(zone, 1);
        const row = this._modalRoot.querySelector('#gh-mode-row');
        const modes = [
            { key: 'manual', label: 'Мануал' },
            { key: 'timer', label: 'Таймер' },
            { key: 'auto', label: 'Авто' },
        ];

        row.innerHTML = modes
            .map((m) => `<div class="gh-pill ${m.key === cfg.mode ? 'active' : ''}" data-mode="${m.key}">${m.label}</div>`)
            .join('');

        row.querySelectorAll('.gh-pill').forEach((el) => {
            el.addEventListener('click', () => {
                const newMode = el.dataset.mode;
                if (newMode === cfg.mode) return;
                this._setZoneMode(zone, newMode);
            });
        });
    }

    _renderTabsRow() {
        const { activeChannel } = this._modalState;
        const row = this._modalRoot.querySelector('#gh-tabs-row');

        row.innerHTML = Array.from({ length: CHANNELS_PER_ZONE }, (_, idx) => idx + 1)
            .map((ch) => `<div class="gh-pill ${ch === activeChannel ? 'active' : ''}" data-channel="${ch}">Канал ${ch}</div>`)
            .join('');

        row.querySelectorAll('.gh-pill').forEach((el) => {
            el.addEventListener('click', () => {
                this._modalState.activeChannel = Number(el.dataset.channel);
                this._renderTabsRow();
                this._renderModalBody();
            });
        });
    }

    _renderModalBody() {
        const { zone, activeChannel } = this._modalState;
        const zoneMode = this._getChannelState(zone, 1).mode; // спільний на всю зону
        const body = this._modalRoot.querySelector('#gh-modal-body');

        let html;
        if (zoneMode === 'manual') {
            html = this._renderManualSection(zone, activeChannel);
        } else if (zoneMode === 'timer') {
            html = this._renderTimerSection(zone, activeChannel);
        } else {
            // TODO: авторежим ще не реалізовано на бекенді (service.py: mode=='auto' -> skip)
            html = `<div class="gh-auto-placeholder">Авторежим ще не реалізовано (TODO)</div>`;
        }

        body.innerHTML = html;

        if (zoneMode === 'manual') {
            this._attachManualListeners(zone, activeChannel);
        } else if (zoneMode === 'timer') {
            this._attachTimerListeners(zone, activeChannel);
        }
    }

    _renderManualSection(zone, channel) {
        const cfg = this._getChannelState(zone, channel);
        const isOn = cfg.state === 'ON';
        const brightnessPct = cfg.brightness || 0;

        return `
            <div class="gh-section-title">Ручний режим (Канал ${channel})</div>
            <div class="gh-field-row">
                <div class="gh-field-label">Стан</div>
                <button class="gh-toggle-btn ${isOn ? 'on' : ''}" id="gh-manual-toggle">${isOn ? 'Увімкнено' : 'Вимкнено'}</button>
            </div>
            <div class="gh-field-row">
                <div class="gh-field-label">Яскравість</div>
                <input type="range" min="0" max="100" id="gh-manual-range" value="${brightnessPct}">
                <input type="number" min="0" max="100" id="gh-manual-number" value="${brightnessPct}">
            </div>
        `;
    }

    _attachManualListeners(zone, channel) {
        const toggleBtn = this._modalRoot.querySelector('#gh-manual-toggle');
        const range = this._modalRoot.querySelector('#gh-manual-range');
        const number = this._modalRoot.querySelector('#gh-manual-number');

        // ВАЖЛИВО: LogicService не має окремого поля "state" для запису -
        // "state" на виході лише ПОХІДНИЙ від brightness (brightness>0 -> ON).
        // Тому і тумблер, і повзунок керують ОДНИМ полем - brightness.
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const willTurnOn = !toggleBtn.classList.contains('on');
                const cfg = this._getChannelState(zone, channel);
                const targetBrightness = willTurnOn ? (cfg.brightness > 0 ? cfg.brightness : 100) : 0;

                this._publishSet(zone, channel, { brightness: targetBrightness });

                toggleBtn.classList.toggle('on', willTurnOn);
                toggleBtn.innerText = willTurnOn ? 'Увімкнено' : 'Вимкнено';
                if (range) range.value = targetBrightness;
                if (number) number.value = targetBrightness;

                this._channelState[groupName(zone, channel)] = {
                    ...cfg, brightness: targetBrightness, state: willTurnOn ? 'ON' : 'OFF',
                };
                this._updateZoneStatuses();
            });
        }

        if (range && number) {
            const sync = (value) => {
                range.value = value;
                number.value = value;
            };
            const commit = (value) => {
                const clamped = clampPercent(value);
                sync(clamped);

                this._publishSet(zone, channel, { brightness: clamped });

                const cfg = this._getChannelState(zone, channel);
                this._channelState[groupName(zone, channel)] = {
                    ...cfg, brightness: clamped, state: clamped > 0 ? 'ON' : 'OFF',
                };

                const toggle = this._modalRoot.querySelector('#gh-manual-toggle');
                if (toggle) {
                    toggle.classList.toggle('on', clamped > 0);
                    toggle.innerText = clamped > 0 ? 'Увімкнено' : 'Вимкнено';
                }
                this._updateZoneStatuses();
            };

            range.addEventListener('input', () => sync(range.value));
            range.addEventListener('change', () => commit(range.value));
            number.addEventListener('change', () => commit(number.value));
        }
    }

    _renderTimerSection(zone, channel) {
        const scenarios = this._getChannelState(zone, channel).scenarios || [];

        let rowsHtml = '';
        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const existing = scenarios[idx] || {};
            const time = existing.time || '';
            const brightness = existing.brightness !== undefined ? existing.brightness : '';
            const [hh, mm] = time.split(':');

            rowsHtml += `
                <div class="gh-scenario-row">
                    <div class="gh-scenario-index">${idx + 1}</div>
                    <div class="gh-time-input" data-slot="${idx}">
                        <input type="text" inputmode="numeric" maxlength="2" placeholder="ГГ"
                               class="gh-time-part gh-time-hh" data-slot="${idx}" value="${hh || ''}">
                        <span class="gh-time-sep">:</span>
                        <input type="text" inputmode="numeric" maxlength="2" placeholder="ХХ"
                               class="gh-time-part gh-time-mm" data-slot="${idx}" value="${mm || ''}">
                        <input type="hidden" data-slot="${idx}" class="gh-slot-time" value="${time}">
                    </div>
                    <input type="number" data-slot="${idx}" class="gh-slot-percent" min="0" max="100" placeholder="%" value="${brightness}">
                </div>
            `;
        }

        return `
            <div class="gh-section-title">Таймерний розклад (Канал ${channel})</div>
            ${rowsHtml}
            <div class="gh-btn-row">
                <button class="gh-secondary-btn" id="gh-copy-scenarios">Копіювати розклад</button>
                <button class="gh-secondary-btn" id="gh-paste-scenarios">Вставити розклад</button>
            </div>
            <button class="gh-save-btn" id="gh-save-scenarios">Зберегти розклад</button>
            <div class="gh-hint">
                Порожні рядки (без часу) ігноруються при збереженні.
                Копіювання/вставка працює між будь-якими зонами й каналами
                (буфер спільний, зберігається в браузері).
            </div>
        `;
    }

    // Кастомний ГГ:ХХ ввід (24-годинний формат). Кожен рядок має два текстові
    // поля (години/хвилини) + приховане поле .gh-slot-time з фінальним "HH:MM" -
    // саме його читають _collectScenariosFromForm/_attachTimerListeners.
    _attachTimeInputListeners() {
        const rows = this._modalRoot.querySelectorAll('.gh-time-input');

        rows.forEach((row) => {
            const hhInput = row.querySelector('.gh-time-hh');
            const mmInput = row.querySelector('.gh-time-mm');
            const hiddenInput = row.querySelector('.gh-slot-time');
            if (!hhInput || !mmInput || !hiddenInput) return;

            const syncHidden = () => {
                const hh = hhInput.value.trim();
                const mm = mmInput.value.trim();
                hiddenInput.value = (hh !== '' && mm !== '')
                    ? `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`
                    : '';
            };

            const clampField = (input, max) => {
                const digitsOnly = input.value.replace(/\D/g, '').slice(0, 2);
                let num = digitsOnly === '' ? null : Number(digitsOnly);
                if (num !== null && num > max) num = max;
                input.value = num === null ? '' : String(num);
            };

            hhInput.addEventListener('input', () => {
                hhInput.value = hhInput.value.replace(/\D/g, '').slice(0, 2);
                syncHidden();
                if (hhInput.value.length === 2) {
                    mmInput.focus();
                    mmInput.select();
                }
            });
            hhInput.addEventListener('blur', () => {
                clampField(hhInput, 23);
                syncHidden();
            });

            mmInput.addEventListener('input', () => {
                mmInput.value = mmInput.value.replace(/\D/g, '').slice(0, 2);
                syncHidden();
            });
            mmInput.addEventListener('blur', () => {
                clampField(mmInput, 59);
                syncHidden();
            });

            mmInput.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && mmInput.value === '') {
                    hhInput.focus();
                }
            });
        });
    }

    _collectScenariosFromForm() {
        const timeInputs = this._modalRoot.querySelectorAll('.gh-slot-time');
        const percentInputs = this._modalRoot.querySelectorAll('.gh-slot-percent');

        const scenarios = [];
        timeInputs.forEach((timeInput, idx) => {
            const time = timeInput.value;
            if (!time) return; // порожній час -> рядок не використовується
            const percentRaw = percentInputs[idx].value;
            scenarios.push({ time, brightness: clampPercent(percentRaw === '' ? 0 : percentRaw) });
        });
        return scenarios;
    }

    // Заповнює вже відрендерені поля форми значеннями з масиву (вставка з буфера) -
    // без перебудови DOM, щоб не втратити фокус/скрол.
    _populateTimerRows(scenarios) {
        const hhInputs = this._modalRoot.querySelectorAll('.gh-time-hh');
        const mmInputs = this._modalRoot.querySelectorAll('.gh-time-mm');
        const timeInputs = this._modalRoot.querySelectorAll('.gh-slot-time');
        const percentInputs = this._modalRoot.querySelectorAll('.gh-slot-percent');

        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const entry = scenarios[idx] || {};
            const time = entry.time || '';
            const brightness = entry.brightness !== undefined ? entry.brightness : '';
            const [hh, mm] = time.split(':');

            if (hhInputs[idx]) hhInputs[idx].value = hh || '';
            if (mmInputs[idx]) mmInputs[idx].value = mm || '';
            if (timeInputs[idx]) timeInputs[idx].value = time;
            if (percentInputs[idx]) percentInputs[idx].value = brightness;
        }
    }

    _flashButtonText(btn, text, restoreText, delayMs = 1500) {
        if (!btn) return;
        btn.innerText = text;
        setTimeout(() => {
            if (btn) btn.innerText = restoreText;
        }, delayMs);
    }

    _attachTimerListeners(zone, channel) {
        this._attachTimeInputListeners();

        const saveBtn = this._modalRoot.querySelector('#gh-save-scenarios');
        const copyBtn = this._modalRoot.querySelector('#gh-copy-scenarios');
        const pasteBtn = this._modalRoot.querySelector('#gh-paste-scenarios');

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const scenarios = this._collectScenariosFromForm();
                this._publishSet(zone, channel, { scenarios });

                const cfg = this._getChannelState(zone, channel);
                this._channelState[groupName(zone, channel)] = { ...cfg, scenarios };

                this._flashButtonText(saveBtn, 'Збережено ✓', 'Зберегти розклад');
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const scenarios = this._collectScenariosFromForm();
                localStorage.setItem(SCENARIO_CLIPBOARD_KEY, JSON.stringify(scenarios));
                this._flashButtonText(copyBtn, 'Скопійовано ✓', 'Копіювати розклад');
            });
        }

        if (pasteBtn) {
            pasteBtn.addEventListener('click', () => {
                const raw = localStorage.getItem(SCENARIO_CLIPBOARD_KEY);
                if (!raw) {
                    this._flashButtonText(pasteBtn, 'Буфер порожній', 'Вставити розклад');
                    return;
                }
                const scenarios = safeParseScenarios(raw);
                this._populateTimerRows(scenarios);
                // Свідомо НЕ публікуємо одразу - користувач бачить вставлені
                // значення у формі й підтверджує окремим "Зберегти розклад".
                this._flashButtonText(pasteBtn, 'Вставлено ✓ (тисни "Зберегти")', 'Вставити розклад', 2000);
            });
        }
    }

    // -------------------------------------------------------------------
    // Оновлення "живих" значень у вже відкритому модальному вікні.
    // Пілюлі режиму (зона-рівень) і поля активного каналу оновлюються з
    // MQTT автоматично; редактор таймера НАЖИВО не чіпаємо навмисно, щоб
    // не затерти незбережений чернетковий розклад користувача.
    // -------------------------------------------------------------------
    _refreshModalLiveValues() {
        if (!this._modalState || !this._modalState.open || !this._modalRoot) return;
        this._renderModeRow();
        this._refreshChannelSpecificValues();
    }

    _refreshChannelSpecificValues() {
        const { zone, activeChannel } = this._modalState;
        const zoneMode = this._getChannelState(zone, 1).mode;
        const cfg = this._getChannelState(zone, activeChannel);

        if (zoneMode === 'manual') {
            const toggleBtn = this._modalRoot.querySelector('#gh-manual-toggle');
            if (toggleBtn) {
                const isOn = cfg.state === 'ON';
                toggleBtn.classList.toggle('on', isOn);
                toggleBtn.innerText = isOn ? 'Увімкнено' : 'Вимкнено';
            }

            const range = this._modalRoot.querySelector('#gh-manual-range');
            const number = this._modalRoot.querySelector('#gh-manual-number');
            if (range && number && document.activeElement !== range && document.activeElement !== number) {
                range.value = cfg.brightness;
                number.value = cfg.brightness;
            }
        }
    }

    // -------------------------------------------------------------------
    disconnectedCallback() {
        if (this._unsubMqtt) {
            this._unsubMqtt();
            this._unsubMqtt = null;
        }
        if (this._unsubBridgeRequest) {
            this._unsubBridgeRequest();
            this._unsubBridgeRequest = null;
        }
        this._mqttSubscribed = false;
    }
}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'greenhouse-zone-card',
    name: 'GreenHouse Zone',
    description: 'Велика плитка керування зонами через LogicService',
});

customElements.define('greenhouse-zone-card', GreenhouseZoneCard);