// ---------------------------------------------------------------------------
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
    return `text.zone_${zone}_l${channel}_scenarios`;
}
function offlineBrightnessEntity(zone, channel) {
    return `number.zone_${zone}_l${channel}_offline_brightness`;
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
        this._z2mGroups = [];         // Масив для збереження даних з MQTT
        this._unsubMqtt = null;       // Функція відписки при закритті сторінки
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

        // Якщо ми ще не підписані, а Home Assistant вже передав робоче з'єднання:
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

        .gh-scenario-row input[type="time"],
        .gh-scenario-row input[type="number"] {
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.06);
            color: var(--primary-text-color);
            width: 100%;
            box-sizing: border-box;
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
        const modeState = hass.states[modeEntity(zone)];
        const currentMode = modeState ? modeState.state : 'manual';

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
                .gh-scenario-row input[type="time"],
                .gh-scenario-row input[type="number"] {
                    padding: 6px 8px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.06);
                    color: var(--primary-text-color);
                    width: 100%;
                    box-sizing: border-box;
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
        const offlineEntity = offlineBrightnessEntity(zone, activeChannel);
        const offlineState = hass.states[offlineEntity];
        const offlineValue = offlineState ? offlineState.state : 50;

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
        const hass = this._hass;
        const raw = hass.states[scenariosEntity(zone, channel)];
        const scenarios = safeParseScenarios(raw ? raw.state : null);

        let rowsHtml = '';
        for (let idx = 0; idx < SCENARIO_SLOTS; idx++) {
            const existing = scenarios[idx] || {};
            const time = existing.time || '';
            const brightness = existing.brightness !== undefined ? existing.brightness : '';

            rowsHtml += `
                <div class="gh-scenario-row">
                    <div class="gh-scenario-index">${idx + 1}</div>
                    <input type="time" data-slot="${idx}" class="gh-slot-time" value="${time}">
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
            this._hass.callService('number', 'set_value', {
                entity_id: offlineBrightnessEntity(zone, channel),
                value: clamped,
            });
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

        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const willTurnOn = !toggleBtn.classList.contains('on');
                this._hass.callService('light', willTurnOn ? 'turn_on' : 'turn_off', {
                    entity_id: entityId,
                });
                toggleBtn.classList.toggle('on', willTurnOn);
                toggleBtn.innerText = willTurnOn ? 'Увімкнено' : 'Вимкнено';
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
                this._hass.callService('light', 'turn_on', {
                    entity_id: entityId,
                    brightness_pct: clamped,
                });
            };

            range.addEventListener('input', () => sync(range.value));
            range.addEventListener('change', () => commit(range.value));
            number.addEventListener('change', () => commit(number.value));
        }
    }

    _attachTimerListeners(zone, channel) {
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
        console.log("🚀 [MQTT Direct] Спроба підписки на zigbee2mqtt/bridge/groups...");
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
            console.log("✓ [MQTT Direct] Підписку успішно оформлено!");
        } catch (err) {
            console.error("❌ [MQTT Direct] Помилка підписки (перевір права користувача):", err);
            this._mqttSubscribed = false; // Відкриваємо замок, щоб спробувати ще раз при наступному оновленні
        }
    }

    // --- 4. ОЧИЩЕННЯ ПРИ ВИДАЛЕННІ КАРТКИ З ЕКРАНА ---
    disconnectedCallback() {
        if (this._unsubMqtt) {
            this._unsubMqtt();
            this._unsubMqtt = null;
            this._mqttSubscribed = false;
        }
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
        
    
}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'greenhouse-zone-card',
    name: 'GreenHouse Zone',
    description: 'Велика плитка керування зонами',
});



customElements.define('greenhouse-zone-card', GreenhouseZoneCard);