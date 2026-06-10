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

static TaskHandle_t s_blink_task_handle = NULL; // Для таски з блиманням світла/ щоб не запустити повторно
static led_strip_handle_t s_led_strip;

bool light_driver_init_done = false;

static uint8_t s_red = 0, s_green = 0, s_blue = 0;

void light_driver_init(void){

    if (light_driver_init_done) {
        ESP_LOGW(TAG, "Light driver is already initialized");
        return;
    }

        led_strip_config_t led_strip_conf = {
        .max_leds = 1,
        .strip_gpio_num = 8,
    };
    led_strip_rmt_config_t rmt_conf = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&led_strip_conf, &rmt_conf, &s_led_strip));
    light_driver_init_done = true;
    // Стандартний стан після ініціалізації
    s_red = 0; s_green = 0; s_blue = 0;

}

void led_strip_set_level(int endpoint_id, uint8_t brightness)
{
    ESP_LOGI(TAG, "Setting brightness for endpoint %d to %d", endpoint_id, brightness);
    
    // Розподіляємо кольори залежно від номера ендпоінту
    switch (endpoint_id)
    {
    case 11:
        s_red = brightness;
        break;
    case 12:
        s_green = brightness;
        break;
    case 13:
        s_blue = brightness;
        break;
    default:
        s_red = s_green = s_blue = brightness;
        break;
    }

    ESP_ERROR_CHECK(led_strip_set_pixel(s_led_strip, 0, s_red, s_green, s_blue));
    ESP_ERROR_CHECK(led_strip_refresh(s_led_strip));
}

void light_driver_turn_off(void)
{
    s_red = s_green = s_blue = 0;
    ESP_ERROR_CHECK(led_strip_set_pixel(s_led_strip, 0, s_red, s_green, s_blue));
    ESP_ERROR_CHECK(led_strip_refresh(s_led_strip));
}


static void led_strip_blink_task(void *pvParameters)
{
    ESP_LOGI(TAG, "Таску блимання успішно запущено.");
    while (1) {
        // Вмикаємо синій колір
        led_strip_set_pixel(s_led_strip, 0, 0, 0, 255);
        led_strip_refresh(s_led_strip);
        vTaskDelay(pdMS_TO_TICKS(200)); 

        // Вимикаємо світлодіод
        led_strip_set_pixel(s_led_strip, 0, 0, 0, 0);
        led_strip_refresh(s_led_strip);
        vTaskDelay(pdMS_TO_TICKS(800)); 
    }
}

// Функція для СТАРТУ блимання
void led_strip_blink_start(void)
{
    // Перевіряємо, чи таска ВЖЕ не запущена, щоб не створити дублікат
    if (s_blink_task_handle == NULL) {
        xTaskCreate(
            led_strip_blink_task,   // Функція таски
            "led_strip_blink_task",        // Назва для дебагу
            2048,                      // Розмір стеку
            NULL,                      // Параметри
            5,                         // Пріоритет
            &s_blink_task_handle       // ПЕРЕДАЮ АДРЕСУ ХЕНДЛА, щоб зберегти його
        );
        ESP_LOGI(TAG, "Створено нову таску блимання.");
    } else {
        ESP_LOGW(TAG, "Таска блимання вже працює, ігноруємо повторний старт.");
    }
}

// Функція для ЗУПИНКИ блимання
void led_strip_blink_stop(void)
{
    if (s_blink_task_handle != NULL) {
        vTaskDelete(s_blink_task_handle); // Видаляємо таску зі стеку операційної системи
        s_blink_task_handle = NULL;        // Обов'язково зануляємо хендл!
        
        // Гарантовано вимикаємо світлодіод після зупинки
        led_strip_set_pixel(s_led_strip, 0, 0, 0, 0);
        led_strip_refresh(s_led_strip);
        
        ESP_LOGI(TAG, "Таску блимання зупинено, світлодіод вимкнено.");
    } else {
        ESP_LOGW(TAG, "Спроба зупинити блимання, яке не було запущене.");
    }
}

void led_strip_blink_specific_times(uint8_t times)
{
    for (int i = 0; i < times; i++) {
        // Вмикаємо зелений колір
        led_strip_set_pixel(s_led_strip, 0, 0, 255, 0);
        led_strip_refresh(s_led_strip);
        vTaskDelay(pdMS_TO_TICKS(200)); 

        // Вимикаємо світлодіод
        led_strip_set_pixel(s_led_strip, 0, 0, 0, 0);
        led_strip_refresh(s_led_strip);
        vTaskDelay(pdMS_TO_TICKS(400)); 
    }
}