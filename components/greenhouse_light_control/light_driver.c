#include "light_driver.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "led_strip.h"

#include "endpoint_config.h" // NUMBER_OF_CHANNEL_ENDPOINTS

static const char *TAG = "LIGHT_DRIVER";

#define LEDC_TIMER              LEDC_TIMER_0
#define LEDC_MODE               LEDC_LOW_SPEED_MODE
#define LEDC_DUTY_RES           LEDC_TIMER_8_BIT 
#define LEDC_FREQUENCY          (5000)   

static led_strip_handle_t s_led_strip;

static uint8_t s_red = 0, s_green = 0, s_blue = 0;

void light_driver_init(void){

        led_strip_config_t led_strip_conf = {
        .max_leds = 1,
        .strip_gpio_num = 8,
    };
    led_strip_rmt_config_t rmt_conf = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&led_strip_conf, &rmt_conf, &s_led_strip));
    
    // Стандартний стан після ініціалізації
    s_red = 0; s_green = 0; s_blue = 0;

}

void light_driver_set_level(int endpoint_id, uint8_t brightness)
{
    ESP_LOGI(TAG, "Setting brightness for endpoint %d to %d", endpoint_id, brightness);
    
    // Розподіляємо кольори залежно від номера ендпоінту
    switch (endpoint_id)
    {
    case 2:
        s_red = brightness;
        break;
    case 3:
        s_green = brightness;
        break;
    case 4:
        s_blue = brightness;
        break;
    default:
        s_red = s_green = s_blue = brightness;
        break;
    }

    ESP_ERROR_CHECK(led_strip_set_pixel(s_led_strip, 0, s_red, s_green, s_blue));
    ESP_ERROR_CHECK(led_strip_refresh(s_led_strip));
}
