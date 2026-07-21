#include <stdio.h>
#include "reset_configuration.h"
#include "iot_button.h"
#include "button_gpio.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "light_driver.h"
#include "freertos/FreeRTOS.h"
#include "esp_zigbee_core.h"
#include "dip_switch.h"
#include "endpoint_config.h"
#include "stdint.h"

#include "timers.h"

//#include "esp_zb_switch.h"
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
    ESP_LOGD(TAG, "Кнопку натиснуто! (Один клік)");

    if (reset_configuration_initialized) {
        
        dip_switch_reset_value(); // Скидаємо кешоване значення DIP-свічів, щоб при наступному запиті отримати актуальне

        led_strip_blink_stop();       
        //TODO: ПОТІМ ЗМІНИТИ! БЕЗ МАГІЧНИХ ЧИСЕЛ! 
        light_driver_turn_off(); // Вимикаємо світло, щоб було зрозуміло, що ми вийшли з мережі
        // Зчитуємо та виводимо конфігурацію DIP-свічів
        uint8_t dip_val = dip_switch_get_value();

        ESP_LOGW(TAG, "===============================================");
        ESP_LOGW(TAG, "ПОТОЧНА КОНФІГУРАЦІЯ DIP SWITCH: 0x%02X", dip_val);
        ESP_LOGW(TAG, "Виконується повне очищення пам'яті Zigbee та перезавантаження...");
        ESP_LOGW(TAG, "===============================================");

        led_strip_blink_specific_times(dip_val); // Блимнемо n разів, щоб користувач зрозумів, яка група була вибрана на DIP-свічах перед скиданням

        vTaskDelay(pdMS_TO_TICKS(3000)); // Невелика затримка, щоб користувач встиг прочитати повідомлення
        // Викликаємо очищення локальної пам'яті Zigbee (SDK саме перезавантажить плату)
        esp_zb_factory_reset(); 
    } else {
        uint32_t a = get_current_unix_time();
        printf("Current time: %lu \n", a);
        //send_boot_status_report(1);

        ESP_LOGI(TAG, "Пристрій працює у звичайному режимі (скидання не активовано).");
    }
}

static void button_long_press_1_cb(void *arg, void *usr_data)
{
    if (reset_configuration_initialized) {
        ESP_LOGW(TAG, "Кнопку вже натиснуто! (Довгий клік) - вже ініціалізовано, нічого не робимо.");
        return;
    }
    
    led_strip_blink_start(); // Запускаємо блимання

    // Перевіряємо, чи ми взагалі маємо щось очищати в пам'яті
    if (!esp_zb_bdb_is_factory_new()) {
        ESP_LOGW(TAG, "Пристрій має збережену мережу. Запуск локального від'єднання...");
        
        static esp_zb_zdo_mgmt_leave_req_param_t leave_req;
        memset(&leave_req, 0, sizeof(esp_zb_zdo_mgmt_leave_req_param_t));

        // "локально" або "броадкаст", а не свій шорт-адрес
        // Оце питання перевірити
        leave_req.dst_nwk_addr = 0xFFFF; 
        leave_req.rejoin = 0;
        leave_req.remove_children = 0;
        esp_zb_get_long_address(leave_req.device_address);

        esp_zb_lock_acquire(portMAX_DELAY);
        esp_zb_zdo_device_leave_req(&leave_req, my_zigbee_leave_callback, NULL);
        esp_zb_lock_release();
    } else {
        // Якщо пристрій і так "з коробки", просто дозволяємо зміну конфігурації
        ESP_LOGI(TAG, "Пристрій вже у стані Factory New. Мережевий скид не потрібен.");
        esp_zb_lock_acquire(portMAX_DELAY);
        //my_zigbee_leave_callback(ESP_ZB_ZDP_STATUS_SUCCESS, NULL);
    }

    reset_configuration_initialized = true; 
}

void init_reset_configuration(void)
{
    // Створення конфігурації кнопки
    button_config_t btn_cfg = {
            .long_press_time = LONG_PRESS_TIME_MS, 
            .short_press_time = SHORT_PRESS_TIME_MS, 
        };    
    const button_gpio_config_t btn_gpio_cfg = {
        .gpio_num = BUTTON_GPIO,
        .active_level = 0,
    };

    button_handle_t gpio_btn = NULL;
    iot_button_new_gpio_device(&btn_cfg, &btn_gpio_cfg, &gpio_btn);

    
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