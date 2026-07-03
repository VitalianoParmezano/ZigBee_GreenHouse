class GreenhouseZoneCard extends HTMLElement {

    setConfig(config) {
        this.config = config;
    }

    // ВИПРАВЛЕНО: прибрали "static" — HA викликає метод на інстансі, не на класі
    getGridOptions() {
        return {
            columns: 36,
            rows: 8,
            min_columns: 3,
            max_columns: 36,
        };
    }

    // Для сумісності з Masonry та іншими видами
    getCardSize() {
        return 4;
    }

    set hass(hass) {
        this._hass = hass;

        if (!this.content) {
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

                cell.addEventListener('click', () => {
                    const event = new CustomEvent('ll-custom', {
                        composed: true,
                        bubbles: true,
                        detail: {
                            browser_mod: {
                                service: 'browser_mod.popup',
                                data: {
                                    title: `Керування: Зона ${i}`,
                                    content: {
                                        type: 'custom:layout-card',
                                        layout_type: 'custom:grid-layout',
                                        layout: { 'grid-template-columns': '1fr' },
                                        cards: [{
                                                type: 'custom:mushroom-light-card',
                                                entity: `light.zone_${i}_channel_1`,
                                                name: 'Канал 1',
                                                show_brightness_control: true,
                                            },
                                            {
                                                type: 'custom:mini-graph-card',
                                                entities: [{
                                                    entity: `light.zone_${i}_channel_1`,
                                                    attribute: 'brightness',
                                                    name: 'Історія яскравості К1',
                                                }],
                                                line_color: '#4caf50',
                                                hours_to_show: 24,
                                                points_per_hour: 4,
                                                show: { fill: 'fade' },
                                                min: 0,
                                                max: 254,
                                            },
                                            {
                                                type: 'custom:mushroom-light-card',
                                                entity: `light.zone_${i}_channel_2`,
                                                name: 'Канал 2',
                                                show_brightness_control: true,
                                            },
                                            {
                                                type: 'custom:mini-graph-card',
                                                entities: [{
                                                    entity: `light.zone_${i}_channel_2`,
                                                    attribute: 'brightness',
                                                    name: 'Історія яскравості К2',
                                                }],
                                                line_color: '#03a9f4',
                                                hours_to_show: 24,
                                                points_per_hour: 4,
                                                show: { fill: 'fade' },
                                                min: 0,
                                                max: 254,
                                            },
                                            {
                                                type: 'custom:mushroom-light-card',
                                                entity: `light.zone_${i}_channel_3`,
                                                name: 'Канал 3',
                                                show_brightness_control: true,
                                            },
                                            {
                                                type: 'custom:mini-graph-card',
                                                entities: [{
                                                    entity: `light.zone_${i}_channel_3`,
                                                    attribute: 'brightness',
                                                    name: 'Історія яскравості К3',
                                                }],
                                                line_color: '#ff9800',
                                                hours_to_show: 24,
                                                points_per_hour: 4,
                                                show: { fill: 'fade' },
                                                min: 0,
                                                max: 254,
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    });
                    cell.dispatchEvent(event);
                });

                this.content.appendChild(cell);
            }
        }

        // Оновлення стану зон
        for (let i = 1; i <= 6; i++) {
            const iconEl = this.querySelector(`#zone-${i}-icon`);
            const statusEl = this.querySelector(`#zone-${i}-val`);

            if (!iconEl || !statusEl) continue;

            const entityId = `light.zone_${i}_channel_1`;
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
}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'greenhouse-zone-card',
    name: 'GreenHouse Zone',
    description: 'Велика плитка керування зонами',
});

customElements.define('greenhouse-zone-card', GreenhouseZoneCard);