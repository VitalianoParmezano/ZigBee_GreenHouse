#include <stdio.h>
#include "reset_configuration.h"
#include "iot_button.h"
#include "button_gpio.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "light_driver.h"
#include "freertos/FreeRTOS.h"
#include "esp_zigbee_core.h"
// #include "esp_zigbee_zdo_command.h"

static bool reset_configuration_initialized = false;

static const char *TAG = "RESET_CONFIG";

static void my_zigbee_leave_callback(esp_zb_zdp_status_t zdo_status, void *user_ctx)
{
    if (zdo_status == ESP_ZB_ZDP_STATUS_SUCCESS) {
        ESP_LOGI(TAG, "Координатор підтвердив вихід нашого пристрою з мережі.");
    } else {
        ESP_LOGW(TAG, "Мережа не відповіла (можливо координатор офлайн, статус: 0x%02x).", zdo_status);
    }
    ESP_LOGW(TAG, "Тепер перемикайте DIP-свічі та коротко натисніть кнопку для ребуту!");
}

static void button_single_click_cb(void *arg, void *usr_data)
{
    ESP_LOGI(TAG, "Кнопку натиснуто! (Один клік)");

    if (reset_configuration_initialized) {
        light_driver_blink_stop();       
        //TODO: ПОТІМ ЗМІНИТИ! БЕЗ МАГІЧНИХ ЧИСЕЛ! 
        light_driver_turn_off(); // Вимикаємо світло, щоб було зрозуміло, що ми вийшли з мережі
        // Зчитуємо та виводимо конфігурацію DIP-свічів
        //uint8_t dip_val = read_dip_switches();
        ESP_LOGW(TAG, "===============================================");
        //ESP_LOGW(TAG, "ПОТОЧНА КОНФІГУРАЦІЯ DIP SWITCH: 0x%02X", dip_val);
        ESP_LOGW(TAG, "Виконується повне очищення пам'яті Zigbee та перезавантаження...");
        ESP_LOGW(TAG, "===============================================");

        vTaskDelay(pdMS_TO_TICKS(3000)); // Невелика затримка, щоб користувач встиг прочитати повідомлення
        // Викликаємо очищення локальної пам'яті Zigbee (SDK саме перезавантажить плату)
        esp_zb_factory_reset(); 
    } else {
        ESP_LOGI(TAG, "Пристрій працює у звичайному режимі (скидання не активовано).");
    }
}

static void button_long_press_1_cb(void *arg, void *usr_data)
{
    ESP_LOGW(TAG, "Утримування кнопки зафіксовано! Запуск від'єднання...");

    light_driver_blink_start(); // Запускаємо вічне червоне блимання

    static esp_zb_zdo_mgmt_leave_req_param_t leave_req;
    memset(&leave_req, 0, sizeof(esp_zb_zdo_mgmt_leave_req_param_t));

    leave_req.dst_nwk_addr = esp_zb_get_short_address(); 
    leave_req.rejoin = 0;
    leave_req.remove_children = 0;
    esp_zb_get_long_address(leave_req.device_address);

    // Мутекс
    esp_zb_lock_acquire(portMAX_DELAY);
    esp_zb_zdo_device_leave_req(&leave_req, my_zigbee_leave_callback, NULL);
    esp_zb_lock_release();

    reset_configuration_initialized = true; 
}


void init_reset_configuration(void)
{
    // Створення конфігурації кнопки
    const button_config_t btn_cfg = {0};
    
    const button_gpio_config_t btn_gpio_cfg = {
        .gpio_num = BUTTON_GPIO,
        .active_level = 0,
    };

    button_handle_t gpio_btn = NULL;
    esp_err_t ret = iot_button_new_gpio_device(&btn_cfg, &btn_gpio_cfg, &gpio_btn);
    
    if(NULL == gpio_btn) {
        ESP_LOGE(TAG, "Button create failed");
        return;
    }

    iot_button_register_cb(gpio_btn, BUTTON_SINGLE_CLICK, NULL, button_single_click_cb, NULL);

    button_event_args_t long_press_args = {
    .long_press.press_time = LONG_PRESS_TIME_MS,
    };

    iot_button_register_cb(gpio_btn, BUTTON_LONG_PRESS_START, &long_press_args, button_long_press_1_cb, NULL);
        



}