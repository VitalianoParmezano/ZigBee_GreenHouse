// GreenhouseMaxUmolCard - малесенька картка на 3 поля: максимальний μmol/m²/s
// по кожному каналу. Обмін даними - MQTT, один-єдиний топік в обидва боки:
//
//   LogicService/bridge/max_umol   <- retained, читається при підписці
//                                      {max_umol_channel1, max_umol_channel2,
//                                       max_umol_channel3}
//   LogicService/bridge/max_umol   -> той самий топік, публікується повний
//                                      об'єкт при зміні будь-якого поля

const TOPIC = 'LogicService/bridge/max_umol';
const CHANNELS = [1, 2, 3];

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
                (message) => this._onMessage(message),
                { type: 'mqtt/subscribe', topic: TOPIC }
            );
        } catch (err) {
            console.error('[GreenhouseMaxUmolCard] Не вдалось підписатись на MQTT:', err);
            this._mqttSubscribed = false; // дозволяємо повторну спробу при наступному set hass()
        }
    }

    _onMessage(message) {
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
                    margin-bottom: 12px;
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
                <div class="ghmu-title">Максимальний рівень (μmol/m²/s)</div>
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