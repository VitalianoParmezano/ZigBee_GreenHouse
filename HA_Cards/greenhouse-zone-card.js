// GreenhouseZoneCard - зони/канали керуються через LogicService, без прямого
// звернення до zigbee2mqtt чи HA-сутностей. Обмін даними ведеться через MQTT:
//
//   LogicService/Zone_x_Channel_y        <- retained, повний стан каналу
//                                            (mode, scenarios,
//                                            brightness, state)
//   LogicService/Zone_x_Channel_y/set    -> запис (mode/scenarios/brightness)
//   LogicService/bridge/request          <- online/offline пристрою:
//                                            {zone, device, status}
//   LogicService/bridge/sensor           -> глобальний показник датчика
//                                            (тимчасово - зі слайдера в
//                                            Авторежимі): {"umol": ...}
//
// Режим спільний на всю зону: усі CHANNELS_PER_ZONE каналів синхронізуються
// одним значенням mode, клік по пілюлі публікує {mode: ...} в /set кожного
// каналу одразу. Scenarios лишаються per-channel.
//
// Кожен відкритий екземпляр картки незалежно підписується на LogicService/+
// через hass.connection.subscribeMessage, тому зміна в одному екземплярі
// долітає до решти без опитування.

const ZONES = 8;
const CHANNELS_PER_ZONE = 3;
const SCENARIO_SLOTS = 12;
const CONTROL_PREFIX = 'LogicService';
const SCENARIO_CLIPBOARD_KEY = 'greenhouseScenarioClipboardV2'; // V2: рядки містять % для всіх каналів
const DEBUG_UMOL_SENSOR = true; // В авторежимі чи показувати ручний умоль сенсор (повзунок який імітує датчик) true = показати
const ZONE_LABEL = 'Хатка'; // Константа яка використовується для показу кінцевому користувачу

// ---- Налаштування каналів (індекс 0 = канал 1, 1 = канал 2, ...) ----
// Скільки мікромолей (µmol/m²/s) дає канал при 100% потужності.
const CHANNEL_MAX_UMOL = [300, 200, 100];
// Назви та кольори каналів у інтерфейсі.
const CHANNEL_LABELS = ['Red', 'White', 'Blue'];
const CHANNEL_COLORS = ['#e4464d', '#cec5ac', '#397eed'];
// ---- Розміри шрифтів (px) ----
const ZONE_TITLE_FONT_SIZE = 16;  // назва зони на плитці ("Хатка 1")
const ZONE_STATUS_FONT_SIZE = 14; // статус зони на плитці ("Увімкнено · 75%")
const TITLE_FONT_SIZE = 18;       // заголовок вікна ("Керування — Хатка 1")
const TEXT_FONT_SIZE = 14;        // увесь звичайний текст у вікні: режими, підписи, кнопки, підказки
const NUMBER_FONT_SIZE = 14;      // числа поза таблицею (ручний режим, поле датчика)
const TABLE_FONT_SIZE = 16;       // таблиця розкладу (таймер/авто): час, %, µmol, №, шапка
const SMALL_FONT_SIZE = 12;       // дрібний текст: бейдж офлайн, id пристрою, підзаголовок тоста
// true = брати максимум µmol з LogicService/bridge/max_umol (якщо там є значення),
// false = завжди використовувати CHANNEL_MAX_UMOL зверху.
const MAX_UMOL_FROM_MQTT = true;

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

// μmol/m²/s (PPFD) - на відміну від відсотка яскравості, верхньої межі
// свідомо не ставимо (пряме сонце може давати ~2000+), лише невід'ємне ціле.
function clampUmol(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.round(n));
}

// Мікромолі: максимум 1 знак після коми, без зайвого ",0" (12,5 / 12 / 0,3).
function formatUmol(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '0';
    return String(Math.round(n * 10) / 10).replace('.', ',');
}

// '#rrggbb' -> [r, g, b]
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

const DEFAULT_CHANNEL_STATE = { mode: 'manual', scenarios: [], brightness: 0, state: 'OFF' };

class GreenhouseZoneCard extends HTMLElement {

    constructor() {
        super();
        this._mqttSubscribed = false;
        this._unsubMqtt = null;
        this._unsubBridgeRequest = null;
        // Zone_x_Channel_y -> { mode, scenarios, brightness, state }, наповнюється
        // лише з LogicService/+ (retained стан + живі оновлення).
        this._channelState = {};
        // device (ieee-адреса) -> { zone, device, status: 'offline' }.
        // Прибирається лише повідомленням status: 'online' для того ж device,
        // не залежить від закриття тоста.
        this._offlineDevices = {};

        // Стосується мікромолей
        this._unsubMaxUmol = null;
        this._maxUmolState = {};

        this._toastStackRoot = null;
        this._offlineListModalRoot = null;
        // Тимчасова заміна реального датчика PPFD: локальне (лише в цій
        // вкладці браузера) останнє виставлене значення μmol зі слайдера.
        this._lastUmolReading = 0;
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

        try {
            this._unsubMaxUmol = await this._hass.connection.subscribeMessage(
                (message) => this._onMaxUmolMessage(message),
                { type: 'mqtt/subscribe', topic: `${CONTROL_PREFIX}/bridge/max_umol` }
            );
        } catch (err) {
            console.error('[GreenhouseZoneCard] Не вдалось підписатись на max_umol:', err);
        }

    }

    // Обробка повідомлення з LogicService/Zone_x_Channel_y, яке містить JSON-об'єкт виду:
    // {
    //   "mode": "manual",
    //   "scenarios": [...],
    //   "brightness": 75,
    //   "state": "ON"
    // }
    _onLogicServiceMessage(message) {
        const prefix = `${CONTROL_PREFIX}/`;
        if (!message.topic.startsWith(prefix)) return;

        const group = message.topic.slice(prefix.length);
        // Цікавить лише LogicService/<group>, без /set, /get і без bridge/*.
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

        const { zone } = this._modalState;
        const info = parseGroupName(group);
        if (!info || info.zone !== zone) return;

        // Режим спільний на зону - зміна будь-якого каналу могла його стосуватись,
        // тож пілюлі оновлюються завжди.
        this._renderModeRow();
        this._refreshChannelSpecificValues();
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

    // Обробка повідомлення з LogicService/bridge/max_umol, яке містить JSON-об'єкт виду:
    // {
    //   "max_umol_channel1": 123,
    //   "max_umol_channel2": 456,
    //   "max_umol_channel3": 789
    // }
    // Використовується для оновлення глобального показника PPFD (μmol/m²/s) у картці, а також для синхронізації значень у модальному вікні, якщо воно відкрите.
    _onMaxUmolMessage(message) {
        try {
            this._maxUmolState = JSON.parse(message.payload);
            
            // Якщо модалка відкрита, оновлюємо живі значення (щоб одразу показати нові цифри)
            if (this._modalState && this._modalState.open) {
                this._refreshChannelSpecificValues();
            }
        } catch (err) {
            console.warn('[GreenhouseZoneCard] Некоректний JSON у max_umol:', message.payload);
        }
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

    // Глобальний показник (не по зоні/каналу) - тимчасова заміна реального
    // датчика PPFD, поки він не підключений.
    async _publishSensorReading(lux) {
        if (!this._hass) return;
        try {
            await this._hass.callService('mqtt', 'publish', {
                topic: `${CONTROL_PREFIX}/bridge/sensor`,
                payload: JSON.stringify({ lux }),
            });
        } catch (err) {
            console.error('[GreenhouseZoneCard] Помилка публікації сенсора:', err);
        }
    }

    // mode - один на всю зону, публікується в /set кожного каналу.
    _setZoneMode(zone, newMode) {
        for (let ch = 1; ch <= CHANNELS_PER_ZONE; ch++) {
            this._publishSet(zone, ch, { mode: newMode });
            const cfg = this._getChannelState(zone, ch);
            this._channelState[groupName(zone, ch)] = { ...cfg, mode: newMode };
        }
        this._renderModeRow();
        this._renderModalBody();
    }

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
            grid-template-columns: repeat(4, 1fr);
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
            font-size: ${ZONE_TITLE_FONT_SIZE}px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .zone-status {
            font-size: ${ZONE_STATUS_FONT_SIZE}px;
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
            font-size: ${SMALL_FONT_SIZE}px;
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
                <div class="zone-title">${ZONE_LABEL} ${i}</div>
                <div class="zone-status" id="zone-${i}-val">Офлайн</div>
            `;

            cell.addEventListener('click', () => this._openZoneModal(i));
            this.content.appendChild(cell);
        }

        this.querySelector('#gh-offline-badge').addEventListener('click', () => this._openOfflineListModal());
        this._updateOfflineBadge();
    }

    _updateZoneStatuses() {
        for (let i = 1; i <= ZONES; i++) {
            const iconEl = this.querySelector(`#zone-${i}-icon`);
            const statusEl = this.querySelector(`#zone-${i}-val`);
            if (!iconEl || !statusEl) continue;

            let arithmetic_mean_brightness = 0;
            let isZoneOn = false;
            
            for (let j = 1; j <= CHANNELS_PER_ZONE; j++) {
                const _cfg = this._getChannelState(i, j);
                
                if (_cfg.state === 'ON') {
                    isZoneOn = true;
                }
                
                const temp_brightness = _cfg.brightness || 0;
                arithmetic_mean_brightness += temp_brightness;
            }
            
            arithmetic_mean_brightness = Math.round(arithmetic_mean_brightness / CHANNELS_PER_ZONE);
            
            statusEl.textContent = isZoneOn ? `Увімкнено · ${arithmetic_mean_brightness}%` : 'Вимкнено';
            iconEl.style.color = isZoneOn ? '#4caf50' : 'grey';
        }
    }

    // Тости живуть у document.body, поза карткою, і зникають лише по кліку
    // на хрестик - без авто-приховування.
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
                .gh-toast-title { font-size: ${TEXT_FONT_SIZE}px; font-weight: 600; }
                .gh-toast-sub { font-size: ${SMALL_FONT_SIZE}px; opacity: 0.7; margin-top: 2px; }
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
                <div class="gh-toast-sub">${ZONE_LABEL} ${zone} · ${device}</div>
            </div>
            <button class="gh-toast-close">✕</button>
        `;

        toast.querySelector('.gh-toast-close').addEventListener('click', () => toast.remove());
        stack.appendChild(toast);
    }

    // Бейдж лишається видимим, поки не прийде status: 'online' - закриття
    // тостів на це не впливає.
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
                .gh-modal-title { font-size: ${TITLE_FONT_SIZE}px; font-weight: 600; }
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
                    font-size: ${TEXT_FONT_SIZE}px;
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
                .gh-offline-item-zone { font-size: ${TEXT_FONT_SIZE}px; font-weight: 600; }
                .gh-offline-item-device { font-size: ${SMALL_FONT_SIZE}px; opacity: 0.6; font-family: monospace; }
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
                        <div class="gh-offline-item-zone">${ZONE_LABEL} ${item.zone}</div>
                        <div class="gh-offline-item-device">${item.device}</div>
                    </div>
                </div>
            `)
            .join('');
    }

    // Модальне вікно зони
    _openZoneModal(zone) {
        this._modalState = { open: true, zone };

        const overlay = document.createElement('div');
        overlay.className = 'gh-modal-overlay';
        overlay.id = 'gh-modal-overlay';

        // Overlay живе в document.body, поза Shadow DOM картки - глобальні
        // стилі туди не дістануть, тому стилі модалки вставляються прямо сюди.
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
                    width: min(780px, 96vw);
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
                    font-size: ${TITLE_FONT_SIZE}px;
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
                    grid-template-columns: 24px 1fr 70px 70px;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 6px;
                }
                
                .gh-slot-calc {
                    height: 34px;
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--primary-color, #03a9f4);
                    background: rgba(255, 255, 255, 0.05);
                    padding: 0 4px;
                    border-radius: 8px;
                    text-align: center;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .gh-scenario-index {
                    font-size: 12px;
                    opacity: 0.5;
                    text-align: right;
                }
                .gh-scenario-row input[type="number"] {
                    height: 34px;
                    box-sizing: border-box;
                    padding: 0 8px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                    font-size: 14px;
                }
                .gh-time-input {
                    height: 34px;
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    padding: 0 6px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                }
                .gh-time-part {
                    width: 28px;
                    padding: 0;
                    border: none;
                    background: transparent;
                    color: var(--primary-text-color);
                    font-size: 14px;
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
                /* ---- Таблиця розкладу ---- */
                .gh-sched-wrap { overflow-x: auto; padding-bottom: 4px; }
                .gh-sched .gh-scenario-row {
                    grid-template-columns: 26px 100px repeat(var(--n), minmax(46px, 1fr)) repeat(var(--n), minmax(48px, 1fr)) minmax(56px, 1fr);
                }
                .gh-sched .gh-scenario-row input[type="number"] { width: 100%; min-width: 0; text-align: center; padding: 0 2px; }
                .gh-sched .gh-scenario-row input[type="number"]::-webkit-outer-spin-button,
                .gh-sched .gh-scenario-row input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
                .gh-sched .gh-scenario-row input[type="number"] { -moz-appearance: textfield; }
                .gh-sched-group, .gh-sched-head { margin-bottom: 4px; }
                .gh-sched-group > div {
                    font-size: 11px; opacity: 0.6; text-align: center; text-transform: uppercase;
                    letter-spacing: 0.04em; border-bottom: 1px solid rgba(255, 255, 255, 0.15); padding-bottom: 2px;
                }
                .gh-sched-head > div {
                    font-size: 12px; opacity: 0.85; text-align: center; white-space: nowrap;
                    display: flex; align-items: center; justify-content: center; gap: 4px;
                }
                .gh-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
                .gh-sched .gh-scenario-row { margin-bottom: 0; padding: 3px 0; }
                .gh-sched-group, .gh-sched-head { margin-bottom: 0; }
                /* µmol - розрахункові, не редагуються: сірі, приглушені, без рамки */
                .gh-sched .gh-slot-calc {
                    background: rgba(255, 255, 255, 0.07);
                    border-color: transparent;
                    cursor: default;
                    user-select: none;
                }
                .gh-sched .gh-slot-calc.total {
                    background: rgba(255, 255, 255, 0.07);
                    color: var(--primary-text-color);
                }
                /* вертикальна риска між % та µmol */
                .gh-sched .gh-umol-first { position: relative; }
                .gh-sched .gh-umol-first::before {
                    content: ''; position: absolute; left: -5px; top: -3px; bottom: -3px;
                    width: 1px; background: rgba(255, 255, 255, 0.28);
                }
                /* ---- Ручний режим ---- */
                .gh-m-total { margin: 4px 0 6px 0; }
                .gh-m-legend-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
                .gh-m-total-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
                .gh-m-small { font-size: 13px; opacity: 0.7; }
                .gh-m-power { font-weight: 700; font-variant-numeric: tabular-nums; }
                .gh-m-power span { font-size: 14px; font-weight: 400; opacity: 0.7; }
                .gh-m-percent { font-weight: 650; font-variant-numeric: tabular-nums; }
                .gh-m-stack { display: flex; height: 12px; flex: 1 1 auto; min-width: 0; background: rgba(255, 255, 255, 0.12); border-radius: 12px; overflow: hidden; }
                .gh-m-stack > div { height: 100%; transition: width 0.12s; }
                .gh-m-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; opacity: 0.85; }
                .gh-m-legend span { display: flex; align-items: center; gap: 5px; }
                .gh-m-channel { padding: 16px 2px 14px 2px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
                .gh-m-channel:last-of-type { border-bottom: 0; }
                .gh-m-ch-top, .gh-m-ch-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
                .gh-m-ch-top { margin-bottom: 10px; }
                .gh-m-ch-name { display: flex; align-items: center; gap: 8px; font-size: 15px; }
                .gh-orb { width: 14px; height: 14px; border-radius: 50%; display: inline-block; box-shadow: inset -2px -2px 4px rgba(0,0,0,0.35), inset 2px 2px 4px rgba(255,255,255,0.35); }
                .gh-m-ch-value { font-size: 14px; font-variant-numeric: tabular-nums; }
                .gh-m-ch-bottom { margin-top: 8px; font-size: 13px; opacity: 0.85; }
                .gh-m-ch-bottom input[type="number"] {
                    width: 64px; padding: 5px 8px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06); color: var(--primary-text-color);
                }
                .gh-m-channel-simple { padding: 14px 0; }
                .gh-m-range { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; background: transparent; cursor: pointer; display: block; margin: 0; --fill: 0%; --accent: #888; }
                .gh-m-range::-webkit-slider-runnable-track { height: 12px; background: linear-gradient(to right, var(--accent) var(--fill), rgba(255,255,255,0.12) var(--fill)); border-radius: 12px; }
                .gh-m-range::-moz-range-track { height: 12px; background: linear-gradient(to right, var(--accent) var(--fill), rgba(255,255,255,0.12) var(--fill)); border-radius: 12px; }
                .gh-m-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); border: 2px solid var(--accent); box-shadow: 0 1px 6px #0007; margin-top: -5px; }
                .gh-m-range::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); border: 2px solid var(--accent); box-shadow: 0 1px 6px #0007; }
                /* ---- Ручний режим: один рядок = повзунок | поле % | µmol ---- */
                .gh-m-channel-simple { padding: 12px 0; }
                .gh-manual-row { display: flex; align-items: center; gap: 10px; }
                .gh-manual-row .gh-m-range { flex: 1 1 auto; width: auto; min-width: 0; }
                .gh-manual-number {
                    flex: 0 0 auto; width: 56px; box-sizing: border-box; padding: 5px 6px; text-align: center;
                    border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06); color: var(--primary-text-color);
                    -moz-appearance: textfield;
                }
                .gh-manual-number::-webkit-outer-spin-button,
                .gh-manual-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
                .gh-manual-total-pct { border-color: transparent; background: transparent; }
                .gh-manual-percent { flex: 0 0 auto; margin-left: -6px; opacity: 0.8; }
                .gh-manual-umol { flex: 0 0 82px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; opacity: 0.85; }
                /* ---- Єдина типографіка модалки: весь текст однаковий, усі числа однакові ---- */
                .gh-modal-box .gh-pill,
                .gh-modal-box .gh-section-title,
                .gh-modal-box .gh-field-label,
                .gh-modal-box .gh-hint,
                .gh-modal-box .gh-secondary-btn,
                .gh-modal-box .gh-save-btn,
                .gh-modal-box .gh-toggle-btn,
                .gh-modal-box .gh-sched-head > div,
                .gh-modal-box .gh-m-small,
                .gh-modal-box .gh-m-ch-name,
                .gh-modal-box .gh-m-ch-bottom,
                .gh-modal-box .gh-m-legend,
                .gh-modal-box .gh-m-legend span,
                .gh-modal-box .gh-auto-placeholder {
                    font-family: inherit !important;
                    font-size: ${TEXT_FONT_SIZE}px !important;
                    font-weight: 500 !important;
                    line-height: 1.3 !important;
                    text-transform: none !important;
                    letter-spacing: normal !important;
                    opacity: 1 !important;
                }
                .gh-modal-box .gh-slot-percent,
                .gh-modal-box .gh-time-part,
                .gh-modal-box .gh-scenario-index,
                .gh-modal-box .gh-slot-calc,
                .gh-modal-box .gh-m-power,
                .gh-modal-box .gh-m-power span,
                .gh-modal-box .gh-m-percent,
                .gh-modal-box .gh-m-ch-value,
                .gh-modal-box .gh-m-number,
                .gh-modal-box .gh-manual-number,
                .gh-modal-box .gh-manual-percent,
                .gh-modal-box .gh-manual-umol,
                .gh-modal-box .gh-field-row input[type="number"],
                .gh-modal-box #gh-auto-sensor-number {
                    font-family: inherit !important;
                    font-size: ${NUMBER_FONT_SIZE}px !important;
                    font-weight: 700 !important;
                    font-variant-numeric: tabular-nums;
                    opacity: 1 !important;
                    -webkit-text-stroke: 0 !important;
                }
                /* Один шрифт на все: інпути за замовчуванням беруть системний шрифт браузера,
                   тому сімейство задається явно для всіх елементів модалки. */
                .gh-modal-box, .gh-modal-box * {
                    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif)) !important;
                    font-style: normal !important;
                    -webkit-text-stroke: 0 !important;
                    text-shadow: none !important;
                    font-synthesis: none;
                }
                .gh-modal-box .gh-time-sep {
                    font-size: ${NUMBER_FONT_SIZE}px !important;
                    font-weight: 700 !important;
                    opacity: 0.6;
                }
                /* Розмір шрифту таблиці розкладу - керується константою TABLE_FONT_SIZE зверху файлу */
                .gh-modal-box .gh-sched .gh-slot-percent,
                .gh-modal-box .gh-sched .gh-time-part,
                .gh-modal-box .gh-sched .gh-time-sep,
                .gh-modal-box .gh-sched .gh-scenario-index,
                .gh-modal-box .gh-sched .gh-slot-calc,
                .gh-modal-box .gh-sched .gh-sched-head > div {
                    font-size: ${TABLE_FONT_SIZE}px !important;
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
                    <div class="gh-modal-title">Керування — ${ZONE_LABEL} ${zone}</div>
                    <button class="gh-modal-close" id="gh-modal-close">✕</button>
                </div>

                <div class="gh-mode-row" id="gh-mode-row"></div>

                <div class="gh-modal-body" id="gh-modal-body"></div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._closeModal();
        });

        document.body.appendChild(overlay);
        this._modalRoot = overlay;

        overlay.querySelector('#gh-modal-close').addEventListener('click', () => this._closeModal());

        // Клік/тап у числове або часове поле виділяє весь вміст - нове значення
        // просто замінює старе, стирати вручну не треба.
        const isSelectable = (el) => el && el.tagName === 'INPUT' &&
            (el.type === 'number' || el.classList.contains('gh-time-part'));
        overlay.addEventListener('focusin', (e) => {
            const t = e.target;
            if (!isSelectable(t)) return;
            t._ghJustFocused = true;
            setTimeout(() => { try { t.select(); } catch (_) {} t._ghJustFocused = false; }, 0);
        });
        // Без цього mouseup після фокусу скидає виділення (Chrome/Safari).
        overlay.addEventListener('mouseup', (e) => {
            if (isSelectable(e.target) && e.target._ghJustFocused !== undefined) {
                if (e.target._selectOnMouseUp) { e.preventDefault(); }
            }
        });
        overlay.addEventListener('mousedown', (e) => {
            const t = e.target;
            if (isSelectable(t)) t._selectOnMouseUp = document.activeElement !== t;
        });

        this._escHandler = (e) => {
            if (e.key === 'Escape') this._closeModal();
        };
        document.addEventListener('keydown', this._escHandler);

        this._renderModeRow();
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

    // mode - один на зону: пілюлі читають стан каналу 1, клік застосовує
    // режим одразу на кожен канал.
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

    _channelIndexes() {
        return Array.from({ length: CHANNELS_PER_ZONE }, (_, idx) => idx + 1);
    }

    _channelLabel(ch) { return CHANNEL_LABELS[ch - 1] || `К${ch}`; }
    _channelColor(ch) { return CHANNEL_COLORS[ch - 1] || '#03a9f4'; }

    // Скільки µmol дає канал при 100%.
    _getMaxUmol(ch) {
        if (MAX_UMOL_FROM_MQTT && this._maxUmolState) {
            const v = Number(this._maxUmolState[`max_umol_channel${ch}`]);
            if (v) return v;
        }
        return Number(CHANNEL_MAX_UMOL[ch - 1]) || 0;
    }

    _renderModalBody() {
        const { zone } = this._modalState;
        const zoneMode = this._getChannelState(zone, 1).mode; // спільний на всю зону
        const body = this._modalRoot.querySelector('#gh-modal-body');

        let html;
        if (zoneMode === 'manual') {
            html = this._renderManualSection(zone);
        } else if (zoneMode === 'timer') {
            html = this._renderTimerSection(zone);
        } else if (zoneMode === 'auto') {
            html = this._renderAutoSection(zone);
        } else {
            html = `<div class="gh-auto-placeholder">Невідомий режим</div>`;
        }

        body.innerHTML = html;

        if (zoneMode === 'manual') {
            this._attachManualListeners(zone);
        } else if (zoneMode === 'timer') {
            this._attachTimerListeners(zone);
        } else if (zoneMode === 'auto') {
            this._attachAutoListeners(zone);
        }
    }

    // Ручний режим: лише три кольорові повзунки без підписів та чисел.
_renderManualSection(zone) {
    const channelsHtml = this._channelIndexes().map((ch) => {
        const pct = clampPercent(
            this._getChannelState(zone, ch).brightness || 0
        );
        const color = this._channelColor(ch);

        return `
            <div class="gh-m-channel-simple">
                <div class="gh-manual-row">
                    <input
                        type="range"
                        class="gh-m-range"
                        data-ch="${ch}"
                        min="0"
                        max="100"
                        step="1"
                        value="${pct}"
                        aria-label="Канал ${ch}"
                        style="--accent:${color}; --fill:${pct}%"
                    >

                    <input
                        type="number"
                        class="gh-manual-number"
                        data-ch="${ch}"
                        min="0"
                        max="100"
                        value="${pct}"
                    >

                    <span class="gh-manual-percent">%</span>

                    <span
                        class="gh-manual-umol"
                        data-ch="${ch}"
                    >${formatUmol(this._getMaxUmol(ch) * pct / 100)} µmol</span>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="gh-m-channel-simple gh-m-total">
            <div class="gh-manual-row">
                <div class="gh-m-stack" id="gh-manual-stack">
                    ${this._channelIndexes().map((ch) => `
                        <div
                            data-ch="${ch}"
                            style="background:${this._channelColor(ch)};width:0%"
                        ></div>
                    `).join('')}
                </div>

                <span class="gh-manual-number gh-manual-total-pct" id="gh-manual-total-pct">0</span>

                <span class="gh-manual-percent">%</span>

                <span class="gh-manual-umol" id="gh-manual-total">0 µmol</span>
            </div>
        </div>

        ${channelsHtml}

        <div class="gh-btn-row">
            <button class="gh-secondary-btn" id="gh-m-off">
                Вимкнути все
            </button>
            <button class="gh-secondary-btn" id="gh-m-max">
                Все на 100%
            </button>
        </div>
    `;
    }

_updateManualDisplay() {
    if (!this._modalRoot) return;

    let totalUmol = 0;
    let maxUmol = 0;

    this._channelIndexes().forEach((ch) => {
        const range = this._modalRoot.querySelector(
            `.gh-m-range[data-ch="${ch}"]`
        );

        if (!range) return;

        const pct = clampPercent(range.value);
        const channelMax = this._getMaxUmol(ch);
        const umol = channelMax * pct / 100;

        totalUmol += umol;
        maxUmol += channelMax;

        range.style.setProperty('--fill', `${pct}%`);

        const number = this._modalRoot.querySelector(
            `.gh-manual-number[data-ch="${ch}"]`
        );

        const umolText = this._modalRoot.querySelector(
            `.gh-manual-umol[data-ch="${ch}"]`
        );

        const segment = this._modalRoot.querySelector(
            `#gh-manual-stack [data-ch="${ch}"]`
        );

        if (number && document.activeElement !== number) {
            number.value = pct;
        }

        if (umolText) {
            umolText.textContent = `${formatUmol(umol)} µmol`;
        }

        if (segment) {
            segment.style.width = `${
                maxUmol ? (umol / this._channelIndexes().reduce(
                    (sum, c) => sum + this._getMaxUmol(c), 0
                )) * 100 : 0
            }%`;
        }
    });

    const total = this._modalRoot.querySelector('#gh-manual-total');
    const totalPct = this._modalRoot.querySelector('#gh-manual-total-pct');

    if (total) {
        total.textContent =
            `${formatUmol(totalUmol)} µmol`;
    }

    if (totalPct) {
        totalPct.textContent = String(
            maxUmol ? Math.round(totalUmol / maxUmol * 100) : 0
        );
    }
}

_attachManualListeners(zone) {
    const commit = (ch, value) => {
        const pct = clampPercent(value);

        const range = this._modalRoot.querySelector(
            `.gh-m-range[data-ch="${ch}"]`
        );

        const number = this._modalRoot.querySelector(
            `.gh-manual-number[data-ch="${ch}"]`
        );

        if (range) range.value = pct;
        if (number) number.value = pct;

        this._publishSet(zone, ch, { brightness: pct });

        const cfg = this._getChannelState(zone, ch);

        this._channelState[groupName(zone, ch)] = {
            ...cfg,
            brightness: pct,
            state: pct > 0 ? 'ON' : 'OFF'
        };

        this._updateZoneStatuses();
        this._updateManualDisplay();
    };

    this._channelIndexes().forEach((ch) => {
        const range = this._modalRoot.querySelector(
            `.gh-m-range[data-ch="${ch}"]`
        );

        const number = this._modalRoot.querySelector(
            `.gh-manual-number[data-ch="${ch}"]`
        );

        if (range) {
            range.addEventListener('input', () => {
                if (number) number.value = range.value;
                this._updateManualDisplay();
            });

            range.addEventListener('change', () => {
                commit(ch, range.value);
            });
        }

        if (number) {
            number.addEventListener('input', () => {
                const pct = clampPercent(number.value);

                if (range) range.value = pct;

                this._updateManualDisplay();
            });

            number.addEventListener('change', () => {
                commit(ch, number.value);
            });
        }
    });

    const offBtn = this._modalRoot.querySelector('#gh-m-off');
    const maxBtn = this._modalRoot.querySelector('#gh-m-max');

    if (offBtn) {
        offBtn.addEventListener('click', () => {
            this._channelIndexes().forEach((ch) => commit(ch, 0));
        });
    }

    if (maxBtn) {
        maxBtn.addEventListener('click', () => {
            this._channelIndexes().forEach((ch) => commit(ch, 100));
        });
    }

    this._updateManualDisplay();
}


    _renderTimerSection(zone) {
        return this._renderScheduleSection(zone, false);
    }

    // ГГ:ХХ ввід (24-годинний формат): два текстові поля на рядок + приховане
    // поле .gh-slot-time з фінальним "HH:MM", яке читають _collectScenariosFromForm
    // і _attachTimerListeners.
    _attachTimeInputListeners() {
        const rows = this._modalRoot.querySelectorAll('.gh-time-input');

        rows.forEach((row) => {
            const hhInput = row.querySelector('.gh-time-hh');
            const mmInput = row.querySelector('.gh-time-mm');
            const hiddenInput = row.querySelector('input[type="hidden"]');
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

    // Збирає рядки розкладу з форми: [{ time: 'HH:MM', pct: [p_ch1, p_ch2, ...] }].
    // Рядки без часу ігноруються, порожній % вважається 0.
    _collectScheduleRows() {
        const chs = this._channelIndexes();
        const timeInputs = this._modalRoot.querySelectorAll('.gh-slot-time');
        const rows = [];
        timeInputs.forEach((timeInput, idx) => {
            const time = timeInput.value;
            if (!time) return;
            const pct = chs.map((ch) => {
                const input = this._modalRoot.querySelector(`.gh-slot-percent[data-slot="${idx}"][data-ch="${ch}"]`);
                const raw = input ? input.value : '';
                return clampPercent(raw === '' ? 0 : raw);
            });
            rows.push({ time, pct });
        });
        return rows;
    }

    // Рядки розкладу зони: час береться як об'єднання часів усіх каналів,
    // % - з відповідного каналу ('' якщо на цей час у каналу запису немає).
    _getScheduleRows(zone) {
        const chs = this._channelIndexes();
        const byTime = new Map();
        chs.forEach((ch) => {
            safeParseScenarios(this._getChannelState(zone, ch).scenarios).forEach((s) => {
                if (!s || !s.time) return;
                if (!byTime.has(s.time)) byTime.set(s.time, chs.map(() => ''));
                byTime.get(s.time)[ch - 1] = s.brightness !== undefined ? s.brightness : '';
            });
        });
        return [...byTime.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .slice(0, SCENARIO_SLOTS)
            .map(([time, pct]) => ({ time, pct }));
    }

    // Заповнює вже відрендерені поля значеннями з масиву (вставка з буфера /
    // очищення) без перебудови DOM, щоб не втратити фокус/скрол.
    _populateScheduleRows(rows) {
        const chs = this._channelIndexes();
        const hhInputs = this._modalRoot.querySelectorAll('.gh-time-hh');
        const mmInputs = this._modalRoot.querySelectorAll('.gh-time-mm');
        const timeInputs = this._modalRoot.querySelectorAll('.gh-slot-time');

        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const entry = rows[idx] || {};
            const time = entry.time || '';
            const [hh, mm] = time.split(':');

            if (hhInputs[idx]) hhInputs[idx].value = hh || '';
            if (mmInputs[idx]) mmInputs[idx].value = mm || '';
            if (timeInputs[idx]) timeInputs[idx].value = time;

            chs.forEach((ch) => {
                const input = this._modalRoot.querySelector(`.gh-slot-percent[data-slot="${idx}"][data-ch="${ch}"]`);
                if (!input) return;
                const v = Array.isArray(entry.pct) ? entry.pct[ch - 1] : undefined;
                input.value = (v === undefined || v === null) ? '' : v;
            });
        }
    }

    _flashButtonText(btn, text, restoreText, delayMs = 1500) {
        if (!btn) return;
        btn.innerText = text;
        setTimeout(() => {
            if (btn) btn.innerText = restoreText;
        }, delayMs);
    }

    _attachTimerListeners(zone) {
        this._attachScheduleListeners(zone, false);
    }

    // Спільний рендер таблиці розкладу для таймерного й авто режимів:
    // № | час | % по кожному каналу | µmol по кожному каналу | сума µmol
    _renderScheduleSection(zone, isAuto = false) {
        const chs = this._channelIndexes();
        const n = chs.length;
        const rows = this._getScheduleRows(zone);

        const pctHeads = chs.map((ch) =>
            `<div style="color:${this._channelColor(ch)}"><i class="gh-dot" style="background:${this._channelColor(ch)}"></i>%</div>`).join('');
        const umolHeads = chs.map((ch, i) =>
            `<div class="gh-umol-head"><i class="gh-dot" style="background:${this._channelColor(ch)}"></i>µmol</div>`).join('');

        let rowsHtml = '';
        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const row = rows[idx] || { time: '', pct: [] };
            const [hh, mm] = row.time.split(':');

            const pctCells = chs.map((ch) => {
                                const v = row.pct[ch - 1];
                return `<input type="number" class="gh-slot-percent" data-slot="${idx}" data-ch="${ch}" min="0" max="100" placeholder="%" value="${v === undefined ? '' : v}" style="color:${this._channelColor(ch)}">`;
            }).join('');
            const umolCells = chs.map((ch, i) =>
                `<div class="gh-slot-calc${i === 0 ? ' gh-umol-first' : ''}" data-calc-slot="${idx}" data-ch="${ch}" style="color:${this._channelColor(ch)}">–</div>`).join('');

            rowsHtml += `
                <div class="gh-scenario-row">
                    <div class="gh-scenario-index">${idx + 1}</div>
                    <div class="gh-time-input" data-slot="${idx}">
                        <input type="text" inputmode="numeric" maxlength="2" placeholder="ГГ"
                               class="gh-time-part gh-time-hh" data-slot="${idx}" value="${hh || ''}">
                        <span class="gh-time-sep">:</span>
                        <input type="text" inputmode="numeric" maxlength="2" placeholder="ХХ"
                               class="gh-time-part gh-time-mm" data-slot="${idx}" value="${mm || ''}">
                        <input type="hidden" data-slot="${idx}" class="gh-slot-time" value="${row.time}">
                    </div>
                    ${pctCells}
                    ${umolCells}
                    <div class="gh-slot-calc total" data-total-slot="${idx}">–</div>
                </div>
            `;
        }

        const title = isAuto ? 'Авторозклад' : 'Таймерний розклад';
        const minWidth = 26 + 100 + (2 * n + 1) * 50 + (2 * n + 3) * 8;

        return `
            <div class="gh-section-title">${title}</div>
            <div class="gh-sched-wrap">
                <div class="gh-sched" style="--n:${n}; min-width:${minWidth}px">
                    <div class="gh-scenario-row gh-sched-head">
                        <div>№</div><div>Час</div>
                        ${pctHeads}
                        ${umolHeads}
                        <div>Σ</div>
                    </div>
                    ${rowsHtml}
                </div>
            </div>
            <div class="gh-btn-row">
                <button class="gh-secondary-btn" id="gh-copy-scenarios">Копіювати</button>
                <button class="gh-secondary-btn" id="gh-paste-scenarios">Вставити</button>
                <button class="gh-secondary-btn" id="gh-clear-scenarios">Очистити</button>
            </div>
            <button class="gh-save-btn" id="gh-save-scenarios">Зберегти розклад</button>
            <div class="gh-hint">
                Рядки без часу ігноруються при збереженні. Один час - спільний для всіх каналів,
                розклад зберігається окремо в кожен канал. «Очистити» лише очищає форму -
                щоб застосувати, натисни «Зберегти розклад».
            </div>
        `;
    }

    // Перераховує колонки µmol (по каналах і суму) для всіх рядків за % у полях
    // форми. Читає значення прямо з DOM, тож безпечно викликати на кожен ввід.
    _recalcUmolColumn() {
        if (!this._modalRoot) return;
        const chs = this._channelIndexes();

        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            let total = 0;
            let any = false;
            const mix = [0, 0, 0]; // колір суми: кольори каналів, зважені за µmol

            chs.forEach((ch) => {
                const input = this._modalRoot.querySelector(`.gh-slot-percent[data-slot="${idx}"][data-ch="${ch}"]`);
                const calc = this._modalRoot.querySelector(`.gh-slot-calc[data-calc-slot="${idx}"][data-ch="${ch}"]`);
                if (!input || !calc) return;
                if (input.value === '') {
                    calc.textContent = '–';
                    return;
                }
                const umol = this._getMaxUmol(ch) * clampPercent(input.value) / 100;
                total += umol;
                any = true;
                calc.textContent = formatUmol(umol);
                const rgb = hexToRgb(this._channelColor(ch));
                for (let k = 0; k < 3; k++) mix[k] += rgb[k] * umol;
            });

            const totalEl = this._modalRoot.querySelector(`[data-total-slot="${idx}"]`);
            if (totalEl) {
                totalEl.textContent = any ? formatUmol(total) : '–';
                if (any && total > 0) {
                    const [r, g, b] = mix.map((v) => Math.round(v / total));
                    totalEl.style.color = `rgb(${r}, ${g}, ${b})`;
                } else {
                    totalEl.style.color = '';
                }
            }
        }
    }

    _attachScheduleListeners(zone, isAuto = false) {
        this._attachTimeInputListeners();

        const chs = this._channelIndexes();
        const saveBtn = this._modalRoot.querySelector('#gh-save-scenarios');
        const copyBtn = this._modalRoot.querySelector('#gh-copy-scenarios');
        const pasteBtn = this._modalRoot.querySelector('#gh-paste-scenarios');
        const clearBtn = this._modalRoot.querySelector('#gh-clear-scenarios');

        this._modalRoot.querySelectorAll('.gh-slot-percent').forEach((input) => {
            input.addEventListener('input', () => this._recalcUmolColumn());
        });

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const rows = this._collectScheduleRows();
                chs.forEach((ch) => {
                    const scenarios = rows.map((r) => ({ time: r.time, brightness: r.pct[ch - 1] }));
                    this._publishSet(zone, ch, { scenarios });
                    const cfg = this._getChannelState(zone, ch);
                    this._channelState[groupName(zone, ch)] = { ...cfg, scenarios };
                });
                this._flashButtonText(saveBtn, 'Збережено ✓', 'Зберегти розклад');
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                localStorage.setItem(SCENARIO_CLIPBOARD_KEY, JSON.stringify(this._collectScheduleRows()));
                this._flashButtonText(copyBtn, 'Скопійовано ✓', 'Копіювати');
            });
        }

        if (pasteBtn) {
            pasteBtn.addEventListener('click', () => {
                const raw = localStorage.getItem(SCENARIO_CLIPBOARD_KEY);
                if (!raw) {
                    this._flashButtonText(pasteBtn, 'Буфер порожній', 'Вставити');
                    return;
                }
                this._populateScheduleRows(safeParseScenarios(raw));
                this._recalcUmolColumn();
                this._flashButtonText(pasteBtn, 'Вставлено ✓ (тисни "Зберегти")', 'Вставити', 2000);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this._populateScheduleRows([]);
                this._recalcUmolColumn();
                this._flashButtonText(clearBtn, 'Очищено ✓ (тисни "Зберегти")', 'Очистити', 2000);
            });
        }

        this._recalcUmolColumn();
    }
    // Авторежим - це той самий таймерний розклад (ГГ:ХХ + відсоток, 12
    // слотів, копіювання/вставка, збереження), тільки зверху інший текст і
    // міні-слайдер поточного показника замість опису розкладу. Слайдер -
    // тимчасова заміна реального датчика PPFD: рухаючи його, оператор сам
    // публікує {"lux": ...} у LogicService/bridge/sensor,
    _renderAutoSection(zone) {
            const lux = this._lastUmolReading || 0;
            const topHtml = `
                <div class="gh-section-title">Поточний рівень (тимчасово вручну, потім - датчик)</div>
                <div class="gh-field-row">
                    <input type="range" min="0" max="2500" id="gh-auto-sensor-range" value="${lux}">
                    <input type="number" min="0" id="gh-auto-sensor-number" value="${lux}">
                </div>
                <div class="gh-hint" style="margin-bottom: 20px;">
                    Публікується в LogicService/bridge/sensor ({"lux": ...}) - тимчасова
                    заміна реального датчика PPFD, поки він не підключений.
                </div>
            `;

            if (!DEBUG_UMOL_SENSOR){
                return this._renderScheduleSection(zone, true);
            }
            return topHtml + this._renderScheduleSection(zone, true);
        }

    _collectAutoScenariosFromForm() {
        const timeInputs = this._modalRoot.querySelectorAll('.gh-auto-slot-time');
        const percentInputs = this._modalRoot.querySelectorAll('.gh-auto-slot-percent');

        const autoScenarios = [];
        timeInputs.forEach((timeInput, idx) => {
            const time = timeInput.value;
            if (!time) return; // порожній час ігнорується, як і в таймерному розкладі
            const percentRaw = percentInputs[idx].value;
            autoScenarios.push({ time, brightness: clampPercent(percentRaw === '' ? 0 : percentRaw) });
        });
        return autoScenarios;
    }

    // Заповнює вже відрендерені поля значеннями з масиву (вставка з буфера) -
    // той самий підхід, що й _populateTimerRows.
    _populateAutoScenarioRows(autoScenarios) {
        const hhInputs = this._modalRoot.querySelectorAll('.gh-auto-slot-time ~ .gh-time-hh, .gh-time-input .gh-time-hh');
        const mmInputs = this._modalRoot.querySelectorAll('.gh-time-input .gh-time-mm');
        const timeInputs = this._modalRoot.querySelectorAll('.gh-auto-slot-time');
        const percentInputs = this._modalRoot.querySelectorAll('.gh-auto-slot-percent');

        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const entry = autoScenarios[idx] || {};
            const time = entry.time || '';
            const [hh, mm] = time.split(':');

            if (hhInputs[idx]) hhInputs[idx].value = hh || '';
            if (mmInputs[idx]) mmInputs[idx].value = mm || '';
            if (timeInputs[idx]) timeInputs[idx].value = time;
            if (percentInputs[idx]) percentInputs[idx].value = entry.brightness !== undefined ? entry.brightness : '';
        }
    }

    _attachAutoListeners(zone) {
            // --- Слайдер поточного рівня ---
            const sensorRange = this._modalRoot.querySelector('#gh-auto-sensor-range');
            const sensorNumber = this._modalRoot.querySelector('#gh-auto-sensor-number');
            
            if (sensorRange && sensorNumber) {
                const sync = (value) => {
                    sensorRange.value = value;
                    sensorNumber.value = value;
                };
                const commit = (value) => {
                    const clamped = clampUmol(value);
                    sync(clamped);
                    this._lastUmolReading = clamped;
                    this._publishSensorReading(clamped);
                };

                sensorRange.addEventListener('input', () => sync(sensorRange.value));
                sensorRange.addEventListener('change', () => commit(sensorRange.value));
                sensorNumber.addEventListener('change', () => commit(sensorNumber.value));
            }

            // --- Слухачі авторозкладу ---
            this._attachScheduleListeners(zone, true);
        }

    // Оновлення живих значень у відкритій модалці: пілюлі режиму і поля
    // активного каналу оновлюються з MQTT; редактор таймера навмисно не
    // чіпається, щоб не затерти незбережений розклад.
    _refreshModalLiveValues() {
        if (!this._modalState || !this._modalState.open || !this._modalRoot) return;
        this._renderModeRow();
        this._refreshChannelSpecificValues();
    }

    _refreshChannelSpecificValues() {
        if (!this._modalState || !this._modalRoot) return;
        const { zone } = this._modalState;
        const zoneMode = this._getChannelState(zone, 1).mode;

        if (zoneMode === 'manual') {
            this._channelIndexes().forEach((ch) => {
                const cfg = this._getChannelState(zone, ch);
                const range = this._modalRoot.querySelector(`.gh-m-range[data-ch="${ch}"]`);
                if (range && document.activeElement !== range) {
                    range.value = clampPercent(cfg.brightness || 0);
                }
            });
            this._updateManualDisplay();
        } else if (zoneMode === 'timer' || zoneMode === 'auto') {
            this._recalcUmolColumn();
        }
    }

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