#include <stdio.h>
#include "dip_switch.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "DIP_SWITCH";
static const int DIP_SWITCH_GPIO_BASE[] = {10, 11, 12};
static uint8_t dip_switch_value = 255; 
static bool dip_switch_initialized = false;

    void dip_switch_init(void) {
    if (dip_switch_initialized) {
        ESP_LOGI(TAG, "DIP switch already initialized.");
        return;
    }
        // Ініціалізація GPIO для DIP-перемикачів
        for (int i = 0; i < sizeof(DIP_SWITCH_GPIO_BASE) / sizeof(DIP_SWITCH_GPIO_BASE[0]); i++) {
            int gpio_num = DIP_SWITCH_GPIO_BASE[i];
            gpio_reset_pin(gpio_num); // Скидаємо налаштування GPIO, щоб уникнути конфліктів
            gpio_set_direction(gpio_num, GPIO_MODE_INPUT);
            gpio_set_pull_mode(gpio_num, GPIO_PULLUP_ONLY); // Використовуємо внутрішній підтягуючий резистор
        }
        dip_switch_initialized = true;
    }

uint8_t dip_switch_get_value(void){

    if (dip_switch_value != 255) {
        ESP_LOGI(TAG, "DIP switch value already calculated: %d", dip_switch_value);
        return dip_switch_value;
    }

    dip_switch_value = 0; // Скидаємо значення перед обчисленням
    
    // Читаємо стан кожного DIP-перемикача і формуємо одне число
    for (int i = 0; i < sizeof(DIP_SWITCH_GPIO_BASE) / sizeof(DIP_SWITCH_GPIO_BASE[0]); i++) {
        int gpio_num = DIP_SWITCH_GPIO_BASE[i];
        int level = !gpio_get_level(gpio_num);
        ESP_LOGI(TAG, "DIP Switch %d (GPIO%d) level: %d", i, gpio_num, level);
        dip_switch_value |= (level << i); // Зсуваємо біт на позицію i і додаємо до результату
    }

    return dip_switch_value;

}

void dip_switch_reset_value(void) {
    dip_switch_value = 255; 
    ESP_LOGI(TAG, "DIP switch value reset. It will be recalculated on next get_value call.");
}
