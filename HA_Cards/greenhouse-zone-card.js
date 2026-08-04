/// ---------------------------------------------------------------------------
// Мапінг зон/каналів на entity_id у Home Assistant.
// ПІДПРАВ ЦІ ФУНКЦІЇ, якщо реальні entity_id у твоїй інсталяції відрізняються
// (звір у Developer Tools -> States після пейрингу пристроїв).
// ---------------------------------------------------------------------------
const CHANNELS_PER_ZONE = 3;
const SCENARIO_SLOTS = 12;

function lightEntity(zone, channel) {
    return `light.zone_${zone}_channel_${channel}`;
}
function modeEntity(zone) {
    return `select.zone_${zone}_mode`;
}
function scenariosEntity(zone, channel) {
    return `text.zone_${zone}_scenarios_l${channel}`;
}
function getGroupNameByNumber(zone, channel = 1){
return(`Zone_${zone}_Channel_${channel}`);
}

// ---------------------------------------------------------------------------
// Утиліти
// ---------------------------------------------------------------------------
function safeParseScenarios(rawValue) {
    if (!rawValue) return [];
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

class GreenhouseZoneCard extends HTMLElement {

    constructor() {
        super();
        this._mqttSubscribed = false; // Замок від повторних підписок
        this._z2mGroups = [];          // Масив груп з zigbee2mqtt/bridge/groups
        this._z2mDevices = [];         // Масив пристроїв з zigbee2mqtt/bridge/devices (ieee -> friendly_name)
        this._deviceStateCache = {};   // friendly_name -> останній повний JSON стану пристрою (zigbee2mqtt/<name>)
        this._unsubMqtt = null;        // Функції відписки при закритті сторінки
        this._unsubMqttDevices = null;
        this._unsubMqttStates = null;
    }

    setConfig(config) {
        this.config = config;
        console.log("Перевірка чи сюди дійшов код 2");

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

        // Підписка на MQTT
        if (!this._mqttSubscribed && this._hass && this._hass.connection) {
            this._mqttSubscribed = true; // Замикаємо замок
            this._subscribeToMqtt();     // Запускаємо WebSocket-запит
        }
        // ------------------------------------

        if (!this.content) {
            this._buildBaseLayout();
        }

        this._updateZoneStatuses(hass);

        if (this._modalState && this._modalState.open) {
            this._refreshModalLiveValues();
        }
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

        /* ---------------- Модальне вікно ---------------- */

        .gh-modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999;
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
            box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
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

      <ha-card>
        <div class="grid-container" id="grid"></div>
      </ha-card>
    `;

        this.content = this.querySelector('#grid');

        for (let i = 1; i <= 6; i++) {
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

    }

    // -------------------------------------------------------------------
    // Оновлення міток стану на плитках зон
    // -------------------------------------------------------------------
    _updateZoneStatuses(hass) {
        for (let i = 1; i <= 6; i++) {
            const iconEl = this.querySelector(`#zone-${i}-icon`);
            const statusEl = this.querySelector(`#zone-${i}-val`);

            if (!iconEl || !statusEl) continue;

            const entityId = lightEntity(i, 1);
            const stateObj = hass.states[entityId];
            const state = stateObj ? stateObj.state : 'none';

            if (['unavailable', 'unknown', 'none'].includes(state)) {
                statusEl.innerText = 'Офлайн';
                iconEl.style.color = 'grey';
                iconEl.style.opacity = '0.5';
            } else {
                iconEl.style.opacity = '1';
                if (state === 'on') {
                    statusEl.innerText = 'Увімкнено';
                    iconEl.style.color = '#4caf50';
                } else {
                    statusEl.innerText = 'Вимкнено';
                    iconEl.style.color = '#03a9f4';
                }
            }
        }
    }

    // -------------------------------------------------------------------
    // Модальне вікно
    // -------------------------------------------------------------------
    _openZoneModal(zone) {
        //absolute = this._getGroupMembersByGroupName(`Zone_${zone}_Channel_1`);

        const hass = this._hass;

        // Читаємо mode напряму з живого MQTT-кешу стану пристрою (той самий блок,
        // що ти бачив у MQTT Explorer), а не через hass.states — це узгоджено з тим,
        // що запис теж іде напряму в Zigbee2MQTT, минаючи HA-сутності.
        const currentMode = this._getFieldFromZoneChannel(zone, 1, 'mode', 'manual');
        console.log('[GreenhouseZoneCard] Відкриття зони', zone, '| поточний mode з MQTT-кешу:', currentMode);

        this._modalState = {
            open: true,
            zone,
            mode: currentMode,
            activeChannel: 1,
        };

        const overlay = document.createElement('div');
        overlay.className = 'gh-modal-overlay';
        overlay.id = 'gh-modal-overlay';

        // Вставляємо стилі модального вікна безпосередньо в сам оверлей,
        // щоб вони працювали в глобальному document.body незалежно від Shadow DOM картки!
        overlay.innerHTML = `
            <style>
                .gh-modal-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.65);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 999999; /* Піднято до 999999, щоб точно перекрити всі шапки HA */
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

        
        // Закриття по кліку на фон або на хрестик
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

        const titleDiv = overlay.querySelector('.gh-modal-title');
        titleDiv.addEventListener('click', function() {
        console.group('Логер погнав!');
        console.log(`Вигляд Станів:`);
        console.log(hass.states);
        console.groupEnd();
        });

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

    _renderModeRow() {
        const { mode } = this._modalState;
        const row = this._modalRoot.querySelector('#gh-mode-row');
        const modes = [
            { key: 'manual', label: 'Мануал' },
            { key: 'timer', label: 'Таймер' },
            { key: 'auto', label: 'Авто' },
        ];

        row.innerHTML = modes
            .map((m) => `<div class="gh-pill ${m.key === mode ? 'active' : ''}" data-mode="${m.key}">${m.label}</div>`)
            .join('');

        row.querySelectorAll('.gh-pill').forEach((el) => {
            el.addEventListener('click', () => {
                const newMode = el.dataset.mode;
                if (newMode === this._modalState.mode) return;

                this._modalState.mode = newMode;

                // Режим спільний на всю зону — пишеться одразу в select-сутність пристрою
                this._hass.callService('select', 'select_option', {
                    entity_id: modeEntity(this._modalState.zone),
                    option: newMode,
                });

                // Режим стосується всього пристрою, тож досить взяти членів
                // групи БУДЬ-ЯКОГО одного каналу зони (беремо канал 1) —
                // фізичні пристрої там ті самі, що й у групах інших каналів.
                this._sendDataByGroupName(`Zone_${this._modalState.zone}_Channel_1`, newMode, 'mode');

                this._renderModeRow();
                this._renderModalBody();
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
        const { zone, mode, activeChannel } = this._modalState;
        const body = this._modalRoot.querySelector('#gh-modal-body');
        const hass = this._hass;

        let html = '';

        // Оффлайн-яскравість — незалежна від режиму настройка каналу,
        // тож показується завжди, під будь-яким режимом.
        // Читається напряму з MQTT-кешу (той самий блок offline_brightness_lN).
        const offlineValue = this._getFieldFromZoneChannel(zone, activeChannel, `offline_brightness_l${activeChannel}`, 50);

        html += `
            <div class="gh-section-title">Яскравість без зв'язку (Канал ${activeChannel})</div>
            <div class="gh-field-row">
                <input type="range" min="0" max="100" id="gh-offline-range" value="${offlineValue}">
                <input type="number" min="0" max="100" id="gh-offline-number" value="${offlineValue}">
            </div>
        `;

        if (mode === 'manual') {
            html += this._renderManualSection(zone, activeChannel);
        } else if (mode === 'timer') {
            html += this._renderTimerSection(zone, activeChannel);
        } else {
            html += `<div class="gh-auto-placeholder">To be continued...</div>`;
        }

        body.innerHTML = html;

        this._attachOfflineBrightnessListeners(zone, activeChannel);

        if (mode === 'manual') {
            this._attachManualListeners(zone, activeChannel);
        } else if (mode === 'timer') {
            this._attachTimerListeners(zone, activeChannel);
        }
    }

    _renderManualSection(zone, channel) {
        const hass = this._hass;
        const entityId = lightEntity(zone, channel);
        const stateObj = hass.states[entityId];
        const isOn = stateObj ? stateObj.state === 'on' : false;
        const brightnessPct = stateObj && stateObj.attributes.brightness
            ? Math.round((stateObj.attributes.brightness / 255) * 100)
            : 0;

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

    _renderTimerSection(zone, channel) {
        // Читається напряму з MQTT-кешу (scenarios_lN — рядок JSON, як у Z2M).
        const rawScenarios = this._getFieldFromZoneChannel(zone, channel, `scenarios_l${channel}`, null);
        const scenarios = safeParseScenarios(rawScenarios);

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
            <button class="gh-save-btn" id="gh-save-scenarios">Зберегти розклад</button>
            <div class="gh-hint">Порожні рядки (без часу) ігноруються при збереженні.</div>
        `;
    }

_attachOfflineBrightnessListeners(zone, channel) {
        const range = this._modalRoot.querySelector('#gh-offline-range');
        const number = this._modalRoot.querySelector('#gh-offline-number');
        if (!range || !number) return;

        const sync = (value) => {
            range.value = value;
            number.value = value;
        };

        const commit = (value) => {
            const clamped = clampPercent(value);
            sync(clamped);
            
            this._sendDataByGroupName(getGroupNameByNumber(zone, channel), clamped, 'offline_brightness');
        };

        range.addEventListener('input', () => sync(range.value));
        range.addEventListener('change', () => commit(range.value));
        number.addEventListener('change', () => commit(number.value));
    }

    _attachManualListeners(zone, channel) {
        const toggleBtn = this._modalRoot.querySelector('#gh-manual-toggle');
        const range = this._modalRoot.querySelector('#gh-manual-range');
        const number = this._modalRoot.querySelector('#gh-manual-number');
        const entityId = lightEntity(zone, channel);

        // if (toggleBtn) {
        //     toggleBtn.addEventListener('click', () => {
        //         const willTurnOn = !toggleBtn.classList.contains('on');
        //         this._hass.callService('light', willTurnOn ? 'turn_on' : 'turn_off', {
        //             entity_id: entityId,
        //         });
        //         toggleBtn.classList.toggle('on', willTurnOn);
        //         toggleBtn.innerText = willTurnOn ? 'Увімкнено' : 'Вимкнено';
        //     });
        // }
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const willTurnOn = !toggleBtn.classList.contains('on');
                    const stateValue = willTurnOn ? 'ON' : 'OFF';
                    
                    // Надсилаємо команду прямо в Zigbee2MQTT
                    this._sendDataByGroupName(getGroupNameByNumber(zone, channel), stateValue, 'state');

                    toggleBtn.classList.toggle('on', willTurnOn);
                    toggleBtn.innerText = willTurnOn ? 'Увімкнено' : 'Вимкнено';
                });
            }

        // if (range && number) {
        //     const sync = (value) => {
        //         range.value = value;
        //         number.value = value;
        //     };
        //     const commit = (value) => {
        //         const clamped = clampPercent(value);
        //         sync(clamped);
        //         this._hass.callService('light', 'turn_on', {
        //             entity_id: entityId,
        //             brightness_pct: clamped,
        //         });
        //     };

        //     range.addEventListener('input', () => sync(range.value));
        //     range.addEventListener('change', () => commit(range.value));
        //     number.addEventListener('change', () => commit(number.value));
        // }
        if (range && number) {
            const sync = (value) => {
                range.value = value;
                number.value = value;
            };
            const commit = (value) => {
                const clamped = clampPercent(value);
                sync(clamped);
                
                // Відправляємо яскравість напряму в Zigbee2MQTT минаючи HA
                this._sendDataByGroupName(getGroupNameByNumber(zone, channel), clamped, 'brightness');
            };

            range.addEventListener('input', () => sync(range.value));
            range.addEventListener('change', () => commit(range.value));
            number.addEventListener('change', () => commit(number.value));
        }
    }

    // Кастомний ГГ:ХХ ввід (24-годинний формат) замість системного <input type="time">.
    // Кожен рядок має два текстові поля (години/хвилини) + приховане поле .gh-slot-time,
    // яке зберігає фінальне значення "HH:MM" — саме його читає _attachTimerListeners при збереженні.
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
                // Час валідний лише якщо заповнені обидва поля — інакше рядок вважається порожнім
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
                // Автоперехід на хвилини, коли години введені повністю (2 цифри)
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

            // Backspace у порожньому полі хвилин повертає фокус на години
            mmInput.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && mmInput.value === '') {
                    hhInput.focus();
                }
            });
        });
    }

    _attachTimerListeners(zone, channel) {
        this._attachTimeInputListeners();

        const saveBtn = this._modalRoot.querySelector('#gh-save-scenarios');
        if (!saveBtn) return;

        saveBtn.addEventListener('click', () => {
            const timeInputs = this._modalRoot.querySelectorAll('.gh-slot-time');
            const percentInputs = this._modalRoot.querySelectorAll('.gh-slot-percent');

            const scenarios = [];
            timeInputs.forEach((timeInput, idx) => {
                const time = timeInput.value;
                const percentRaw = percentInputs[idx].value;

                // Порожній час -> рядок вважається невикористаним, пропускається
                if (!time) return;

                scenarios.push({
                    time,
                    brightness: clampPercent(percentRaw === '' ? 0 : percentRaw),
                });
            });

            this._hass.callService('text', 'set_value', {
                entity_id: scenariosEntity(zone, channel),
                value: JSON.stringify(scenarios),
            });

            saveBtn.innerText = 'Збережено ✓';
            setTimeout(() => {
                if (saveBtn) saveBtn.innerText = 'Зберегти розклад';
            }, 1500);
        
            this._sendDataByGroupName(`Zone_${zone}_Channel_${channel}`, JSON.stringify(scenarios), `scenarios`)

        });
    }

    // -------------------------------------------------------------------
    // Оновлення "живих" значень у вже відкритому модальному вікні
    // (наприклад, коли hass.states оновились самостійно від пристрою)
    // -------------------------------------------------------------------
    _refreshModalLiveValues() {
        // Свідомо не перерендерюємо форму цілком під час введення (це б скидало
        // фокус/курсор користувача) — повне оновлення відбувається лише при
        // зміні режиму/вкладки. Живий стан плиток зон оновлюється окремо
        // в _updateZoneStatuses(), що покриває основний випадок використання.
    }

    // Стосується логіки з MQTT 
    _getGroupMembersByGroupName(groupName) {

        console.log('group name received: ', groupName);
        if (!Array.isArray(this._z2mGroups)) {
            console.warn(`[Greenhouse] Дані з MQTT ще не завантажені! Неможливо знайти "${groupName}".`);
            return [];
        }

        const targetGroup = this._z2mGroups.find(g => g.friendly_name === groupName);

        if (!targetGroup) {
            console.warn(`[Greenhouse] Групу "${groupName}" не знайдено в базі Z2M!`);
            return [];
        }
        return (targetGroup.members || []).map(member => member.ieee_address);;
    }

    // --- МЕТОД ПІДПИСКИ НА MQTT ЧЕРЕЗ WEBSOCKET ---
    async _subscribeToMqtt() {
        console.log("Спроба підписки на zigbee2mqtt/bridge/groups...");
        try {
            this._unsubMqtt = await this._hass.connection.subscribeMessage(
                (message) => {
                    try {
                        this._z2mGroups = JSON.parse(message.payload);
                        console.group("Отримано топологію з Z2M!");
                        console.log("Масив груп готовий до використання в JS");
                        console.groupEnd();
                    } catch (e) {
                        console.error("[Greenhouse] Помилка парсингу JSON з MQTT:", e);
                    }
                },
                {
                    type: 'mqtt/subscribe',
                    topic: 'zigbee2mqtt/bridge/groups'
                }
            );
            console.log("✓ [MQTT Direct] Підписку на bridge/groups успішно оформлено!");
        } catch (err) {
            console.error("❌ [MQTT Direct] Помилка підписки на bridge/groups:", err);
            this._mqttSubscribed = false; // Відкриваємо замок, щоб спробувати ще раз при наступному оновленні
        }

        // --- bridge/devices: потрібен для мапінгу ieee_address -> friendly_name ---
        console.log("Спроба підписки на zigbee2mqtt/bridge/devices...");
        try {
            this._unsubMqttDevices = await this._hass.connection.subscribeMessage(
                (message) => {
                    try {
                        this._z2mDevices = JSON.parse(message.payload);
                        console.log("[Greenhouse] bridge/devices оновлено, кількість:", this._z2mDevices.length);
                    } catch (e) {
                        console.error("[Greenhouse] Помилка парсингу bridge/devices:", e);
                    }
                },
                {
                    type: 'mqtt/subscribe',
                    topic: 'zigbee2mqtt/bridge/devices'
                }
            );
            console.log("✓ [MQTT Direct] Підписку на bridge/devices успішно оформлено!");
        } catch (err) {
            console.error("❌ [MQTT Direct] Помилка підписки на bridge/devices:", err);
        }

        // --- zigbee2mqtt/+ : живий кеш ПОВНОГО стану кожного пристрою одним JSON ---
        // Це той самий блок { boot_status, mode, offline_brightness_l1, scenarios_l1, ... },
        // який ти бачиш у MQTT Explorer на топіку zigbee2mqtt/<friendly_name>.
        console.log("Спроба підписки на zigbee2mqtt/+ (стан усіх пристроїв)...");
        try {
            this._unsubMqttStates = await this._hass.connection.subscribeMessage(
                (message) => {
                    const prefix = 'zigbee2mqtt/';
                    if (!message.topic.startsWith(prefix)) return;

                    const rest = message.topic.slice(prefix.length);
                    // Пропускаємо службові підтопіки: bridge/..., .../availability, .../set, .../get тощо —
                    // нас цікавить ЛИШЕ топік виду "zigbee2mqtt/<friendly_name>" без додаткового "/"
                    if (rest.includes('/')) return;

                    try {
                        this._deviceStateCache[rest] = JSON.parse(message.payload);
                    } catch {
                        // Не кожен топік з цим префіксом обов'язково JSON — ігноруємо мовчки
                    }
                },
                {
                    type: 'mqtt/subscribe',
                    topic: 'zigbee2mqtt/+'
                }
            );
            console.log("Підписку на zigbee2mqtt/+ успішно оформлено!");
        } catch (err) {
            console.error("Помилка підписки на zigbee2mqtt/+:", err);
        }
    }

    // Повертає масив friendly_name реальних пристроїв — членів групи
    _getGroupMemberFriendlyNames(groupName) {
        const ieeeList = this._getGroupMembersByGroupName(groupName);
        if (!Array.isArray(this._z2mDevices) || this._z2mDevices.length === 0) {
            console.warn('[Greenhouse] bridge/devices ще не завантажено — friendly_name недоступні.');
            return [];
        }

        return ieeeList
            .map((ieee) => {
                const dev = this._z2mDevices.find((d) => d.ieee_address === ieee);
                if (!dev) {
                    console.warn(`[Greenhouse] Пристрій з ieee_address ${ieee} не знайдено в bridge/devices.`);
                    return null;
                }
                return dev.friendly_name;
            })
            .filter(Boolean);
    }

    // Дістає конкретне поле з живого MQTT-кешу за 3-рівневим пріоритетом:
    // 1. Кеш самої ГРУПИ (для спільних команд, як-от scenarios, offline_brightness).
    // 2. Кеш конкретних ПРИСТРОЇВ-членів (для системних команд, як-от mode).
    // 3. Fallback-значення за замовчуванням.
    _getFieldFromZoneChannel(zone, channel, field, fallback) {
        const groupName = `Zone_${zone}_Channel_${channel}`;

        // --- Перевіряємо кеш самої групи ---
        const groupState = this._deviceStateCache[groupName];
        if (groupState) {
            // У кеші групи поля (scenarios, offline_brightness) зазвичай лежать БЕЗ суфікса каналу (_l1, _l2).
            // Тому прибираємо суфікс _lX за допомогою регулярки, але про всяк випадок перевіряємо обидва варіанти:
            const cleanField = field.replace(/_l\d+$/i, '');
            const groupVal = groupState[field] ?? groupState[cleanField];

            if (groupVal !== undefined && groupVal !== null) {
                console.log(`[Greenhouse] ✓ Прочитано "${cleanField}" =`, groupVal, `з кешу ГРУПИ "${groupName}"`);
                return groupVal;
            }
        }

        // --- Якщо в групі немає, перевіряємо індивідуальні пристрої-члени ---
        const names = this._getGroupMemberFriendlyNames(groupName);
        for (const name of names) {
            const state = this._deviceStateCache[name];
            if (state && state[field] !== undefined && state[field] !== null) {
                console.log(`[Greenhouse] ✓ Прочитано "${field}" =`, state[field], `з пристрою "${name}"`);
                return state[field];
            }
        }

        // --- Fallback ---
        console.log(`[Greenhouse] ⚠️ Поле "${field}" не знайдено ні в групі "${groupName}", ні в пристроях. Fallback:`, fallback);
        return fallback;
    }

    // --- 4. ОЧИЩЕННЯ ПРИ ВИДАЛЕННІ КАРТКИ З ЕКРАНА ---
    disconnectedCallback() {
        if (this._unsubMqtt) {
            this._unsubMqtt();
            this._unsubMqtt = null;
        }
        if (this._unsubMqttDevices) {
            this._unsubMqttDevices();
            this._unsubMqttDevices = null;
        }
        if (this._unsubMqttStates) {
            this._unsubMqttStates();
            this._unsubMqttStates = null;
        }
        this._mqttSubscribed = false;
    }


    handleMqttResponse(payloadString) {
    try {
        const data = JSON.parse(payloadString);
        // Тут ви отримуєте чистий масив об'єктів груп
        console.log("Отримані групи Z2M:", data); 
        
        // Збережіть дані в стейт картки та запустіть рендер
        this.z2mGroups = data; 
        this.requestUpdate(); // Якщо використовуєте LitElement
    } catch (e) {
        console.error("Помилка парсингу JSON з MQTT", e);
    }
    }
        
        /**
     *  Метод для відправки даних на пристрій за його IEEE-адресою
     * @param {string} ieeeAddress - MAC-адреса плати (напр. "0x4831b7fffecf3772")
     * @param {Object} payload - Об'єкт з даними для відправки (напр. { brightness_l1: 100 })
     * @param {string} topicSuffix - Суфікс топіка: '/set' (команда) або '/get' (запит)
     */
    async _sendDataByIEEE(ieeeAddress, payload, topicSuffix = '/set') {
        if (!this._hass) {
            console.error('[Greenhouse] Неможливо відправити MQTT: this._hass не ініціалізовано!');
            return;
        }

        if (!ieeeAddress) {
            console.error('[Greenhouse] IEEE-адреса не вказана!');
            return;
        }

        // Формуємо повний MQTT-топік (наприклад: "zigbee2mqtt/0x4831b7fffecf3772/set")
        const fullTopic = `zigbee2mqtt/${ieeeAddress}${topicSuffix}`;

        // Якщо payload передано як об'єкт — перетворюємо на JSON-рядок
        const payloadString = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        console.log(`📡 [MQTT Publish] -> Топік: "${fullTopic}" | Пейлоад:`, payloadString);

        try {
            // 3. Викливаємо системний сервіс Home Assistant для публікації в MQTT
            await this._hass.callService('mqtt', 'publish', {
                topic: fullTopic,
                payload: payloadString
            });
            console.log(`✓ [MQTT Publish] Успішно відправлено на ${ieeeAddress}`);
        } catch (error) {
            console.error(`❌ [MQTT Publish] Помилка відправки на ${ieeeAddress}:`, error);
        }
    }

/**
     * Експериментальний метод для прямої відправки даних у топік групи Z2M.
     * Оминає ітерацію по пристроях і змушує Z2M записати стан у кеш групи (state.json).
     * @param {string} groupName - Назва групи (напр. "Zone_1_Channel_2")
     * @param {any} payload - Значення для відправки
     * @param {string} type - Тип: 'scenarios', 'offline_brightness', 'mode', 'state', 'brightness' або 'raw'
     */
    async _testSendingDirectlyToGroup(groupName, payload, type = 'raw') {
        if (!this._hass) {
            console.error('❌ [Greenhouse] Неможливо відправити в групу: this._hass не ініціалізовано!');
            return false;
        }

        if (!groupName) {
            console.error('❌ [Greenhouse] Назва групи не вказана!');
            return false;
        }

        const fullTopic = `zigbee2mqtt/${groupName}/set`;
        console.group(`🧪 [Direct Group Send] -> Група: "${groupName}" | Тип: [${type}]`);

        let formattedPayload;

        if (type === 'raw') {
            // Якщо передали готовий об'єкт (напр. { state: 'ON', brightness: 100 })
            formattedPayload = typeof payload === 'object' ? payload : { raw: payload };
        } else {
            // ВАЖЛИВО: Для групи ми НІКОЛИ не додаємо суфікс каналу (_l1, _l2 тощо)!
            // Конвертер Z2M чекає чисті ключі: "scenarios", "offline_brightness", "mode"
            formattedPayload = {
                [type]: payload
            };
        }

        const payloadString = JSON.stringify(formattedPayload);
        console.log(`📡 Топік: "${fullTopic}" | Пейлоад:`, payloadString);

        try {
            await this._hass.callService('mqtt', 'publish', {
                topic: fullTopic,
                payload: payloadString
            });
            console.log(`✓ [Direct Group Send] Успішно відправлено в топік групи "${groupName}"!`);
            console.groupEnd();
            return true;
        } catch (error) {
            console.error(`❌ [Direct Group Send] Помилка відправки в групу "${groupName}":`, error);
            console.groupEnd();
            return false;
        }
    }
    /**
     * Диспетчер відправки даних на групу
     * @param {string} groupName - Назва групи (напр. "Zone_1_Channel_1")
     * @param {any} payload - Значення (масив розкладу, число, рядок або об'єкт)
     * @param {string} type - Тип команди: 'scenarios', 'offline_brightness', 'mode', 'manual' або 'raw'
     * @param {number} delayMs - Затримка між відправками (мс)
     */
    async _sendDataByGroupName(groupName, payload, type = 'raw', delayMs = 250) {

        if (type == 'scenarios' || type == 'offline_brightness' || type == 'brightness' || type == 'state'){
            this._testSendingDirectlyToGroup(groupName, payload, type)
            return;
        }

        const ieeeList = this._getGroupMembersByGroupName(groupName);

        if (!ieeeList || ieeeList.length === 0) {
            console.warn(`⚠️ [Greenhouse] Група "${groupName}" порожня або не знайдена в базі Z2M!`);
            return;
        }

        const channelMatch = groupName.match(/channel_(\d+)/i);
        const channel = channelMatch ? Number(channelMatch[1]) : 1;

        console.group(`🚀 [Group Send] Група: "${groupName}" | Тип: [${type}] | Канал: l${channel}`);

        // ВАЖЛИВО: mode (і будь-які інші майбутні системні поля типу boot_status,
        // device_time) НЕ мають суфікса каналу — це властивості всього пристрою (EP2),
        // а не конкретного каналу. offline_brightness/scenarios — навпаки, завжди per-channel.
        const DEVICE_LEVEL_TYPES = ['mode', 'boot_status', 'device_time'];
        const payloadKey = DEVICE_LEVEL_TYPES.includes(type) ? type : `${type}_l${channel}`;

        const formattedPayload = {
            [payloadKey]: payload
        };

        console.log(formattedPayload);

        for (let i = 0; i < ieeeList.length; i++) {
            const mac = ieeeList[i];
            console.log(`[${i + 1}/${ieeeList.length}] Надсилання на MAC: ${mac}`);

            await this._sendDataByIEEE(mac, formattedPayload, "/set");

            if (i < ieeeList.length - 1 && delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        console.log(`✓ [Group Send] Завершено!`);
        console.groupEnd();
    }


}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'greenhouse-zone-card',
    name: 'GreenHouse Zone',
    description: 'Велика плитка керування зонами',
});



customElements.define('greenhouse-zone-card', GreenhouseZoneCard);