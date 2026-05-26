#include <stdio.h>
#include "reset_configuration.h"
#include "iot_button.h"
#include "button_gpio.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "light_driver.h"

static const char *TAG = "RESET_CONFIG";

static void button_single_click_cb(void *arg, void *usr_data)
{
    // Виводимо повідомлення в лог (зеленим кольором "I")
    ESP_LOGI(TAG, "Кнопку натиснуто! (Один клік)");

}

static void button_long_press_1_cb(void *arg,void *usr_data){
    ESP_LOGI(TAG, "BUTTON_LONG_PRESS_START_1");

}


void init_reset_configuration(void)
{
    // Створення конфігурації кнопки
    const button_config_t btn_cfg = {0}; // {0} застосує базові таймінги за замовчуванням
    
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

