// GreenhouseMaxUmolCard - малесенька картка на 3 поля: максимальний μmol/m²/s
// по кожному каналу. Обмін даними - MQTT, один-єдиний топік в обидва боки:
//
//   LogicService/bridge/max_umol   <- retained, читається при підписці
//                                      {max_umol_channel1, max_umol_channel2,
//                                       max_umol_channel3}
//   LogicService/bridge/max_umol   -> той самий топік, публікується повний
//                                      об'єкт при зміні будь-якого поля

const TOPIC = 'LogicService/bridge/max_umol';
const TOPIC_SENSOR = 'LogicService/bridge/sensor';
const CHANNELS = [1, 2, 3];
const LUX_TO_UMOL_DIVIDER = 69; // Коефіцієнт для перетворення lux в μmol/m²/s

function clampUmol(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.round(n));
}

class GreenhouseMaxUmolCard extends HTMLElement {
    constructor() {
        super();
        this._mqttSubscribed = false;
        this._unsubMqtt = null;
        this._values = { 1: 0, 2: 0, 3: 0 };
        this._sensorValue = '--'; // Початкове значення сенсора
    }

    setConfig(config) {
        this.config = config || {};
    }

    getCardSize() {
        return 2;
    }

    set hass(hass) {
        this._hass = hass;

        if (!this._mqttSubscribed && this._hass && this._hass.connection) {
            this._mqttSubscribed = true;
            this._subscribeToMqtt();
        }

        if (!this.content) {
            this._buildLayout();
        }
    }

    async _subscribeToMqtt() {
        try {
            this._unsubMqtt = await this._hass.connection.subscribeMessage(
                (message) => this._onMessageMaxUmoles(message),
                { type: 'mqtt/subscribe', topic: TOPIC }
            );
        } catch (err) {
            console.error('[GreenhouseMaxUmolCard] Не вдалось підписатись на MQTT:', err);
            this._mqttSubscribed = false; // дозволяємо повторну спробу при наступному set hass()
        }

        try {
            this._unsubSensor = await this._hass.connection.subscribeMessage( // Виправлено
                (message) => this._onMessageSensorValue(message),
                { type: 'mqtt/subscribe', topic: TOPIC_SENSOR }
            );
        } catch (err) {
            console.error('[GreenhouseMaxUmolCard] Не вдалось підписатись на сенсор:', err);
        }

    }

    _onMessageMaxUmoles(message) {
        let parsed;
        try {
            parsed = JSON.parse(message.payload);
        } catch {
            return;
        }

        CHANNELS.forEach((ch) => {
            const val = parsed[`max_umol_channel${ch}`];
            if (val === undefined) return;
            this._values[ch] = clampUmol(val);

            const input = this.querySelector(`#ghmu-ch${ch}`);
            if (input && document.activeElement !== input) {
                input.value = this._values[ch];
            }
        });
    }

    _onMessageSensorValue(message) {
        let parsed;
        try {
            parsed = JSON.parse(message.payload);
        } catch {
            return;
        }

        // Змініть 'parsed.value' на реальний ключ з вашого JSON
        const val = parsed.value !== undefined ? parsed.value : parsed.umol; 
        
        if (val !== undefined) {
            this._sensorValue = clampUmol(val);
            const sensorEl = this.querySelector('#ghmu-sensor-val');
            if (sensorEl) {
                sensorEl.textContent = this._sensorValue / LUX_TO_UMOL_DIVIDER;
            }
        }
    }

    async _publish() {
        if (!this._hass) return;
        const payload = {
            max_umol_channel1: this._values[1],
            max_umol_channel2: this._values[2],
            max_umol_channel3: this._values[3],
        };
        try {
            await this._hass.callService('mqtt', 'publish', {
                topic: TOPIC,
                payload: JSON.stringify(payload),
                retain: true,
            });
        } catch (err) {
            console.error('[GreenhouseMaxUmolCard] Помилка публікації:', err);
        }
    }

    _buildLayout() {
    this.innerHTML = `
    <style>
        :host { display: block; }
        ha-card { padding: 16px; }
        .ghmu-title {
            font-size: 14px;
            font-weight: 600;
            opacity: 0.7;
            margin-bottom: 16px;
        }
        /* Стилі для блоку сенсора */
        .ghmu-sensor-card {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 12px; /* Зменшено з 12px до 6px по вертикалі */
            background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.1);
            border-radius: 8px;
            margin-bottom: 16px; /* Трохи зменшив нижній відступ для компактності */
            border: 1px solid rgba(var(--rgb-primary-color, 3, 169, 244), 0.2);
        }

        .ghmu-sensor-label {
            font-size: 14px;
            font-weight: 500;
        }
        .ghmu-sensor-data {
            font-size: 18px;
            font-weight: 600;
            color: var(--primary-color);
        }
        
        .ghmu-row {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 10px;
        }
        .ghmu-row:last-child { margin-bottom: 0; }
        .ghmu-label {
            flex: 0 0 70px;
            font-size: 13px;
            opacity: 0.8;
        }
        .ghmu-row input[type="number"] {
            flex: 1;
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.06);
            color: var(--primary-text-color);
            box-sizing: border-box;
        }
        .ghmu-unit {
            font-size: 12px;
            opacity: 0.5;
        }
    </style>
    <ha-card>
        <div class="ghmu-title">Налаштування освітлення</div>
        
        <!-- Блок сенсора -->
        <div class="ghmu-sensor-card">
            <div class="ghmu-sensor-label">Поточний рівень:</div>
            <div class="ghmu-sensor-data">
                <span id="ghmu-sensor-val">${this._sensorValue / LUX_TO_UMOL_DIVIDER}</span>
                <span class="ghmu-unit" style="opacity: 0.8;">μmol/m²/s</span>
            </div>
        </div>

        <!-- Інпути каналів -->
        ${CHANNELS.map((ch) => `
            <div class="ghmu-row">
                <div class="ghmu-label">Канал ${ch}</div>
                <input type="number" min="0" id="ghmu-ch${ch}" value="${this._values[ch]}">
                <div class="ghmu-unit">μmol</div>
            </div>
        `).join('')}
    </ha-card>
    `;

    this.content = this.querySelector('ha-card');

    CHANNELS.forEach((ch) => {
        const input = this.querySelector(`#ghmu-ch${ch}`);
        input.addEventListener('change', () => {
            this._values[ch] = clampUmol(input.value);
            input.value = this._values[ch];
            this._publish();
            });
        });
    }

    disconnectedCallback() {
        if (this._unsubMqtt) {
            this._unsubMqtt();
            this._unsubMqtt = null;
        }
        if (this._unsubSensor) {
            this._unsubSensor();
            this._unsubSensor = null;
        }
        this._mqttSubscribed = false;
    }
}
    
window.customCards = window.customCards || [];
window.customCards.push({
    type: 'greenhouse-max-umol-card',
    name: 'GreenHouse Max μmol',
    description: 'Максимальний рівень освітлення (μmol) по каналах',
});

customElements.define('greenhouse-max-umol-card', GreenhouseMaxUmolCard);