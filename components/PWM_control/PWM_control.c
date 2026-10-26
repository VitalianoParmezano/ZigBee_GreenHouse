#include <stdio.h>
#include "PWM_control.h"
#include <stdio.h>
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_gpio.h"
#include "soc/gpio_sig_map.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "PWM control";
static SemaphoreHandle_t output_mutex;

void pwm_prepare_startup_outputs(void)
{
    // Preload output latches before enabling GPIO output drivers.
    ESP_ERROR_CHECK(gpio_set_level(PWM_NEG_GPIO, 0));
    ESP_ERROR_CHECK(gpio_set_level(PWM_OUT_GPIO, 0));
    ESP_ERROR_CHECK(gpio_set_level(PWM_OUT_MIRROR_GPIO, 1));
    const gpio_config_t outputs = {
        .pin_bit_mask = (1ULL << PWM_NEG_GPIO) | (1ULL << PWM_OUT_GPIO) |
                        (1ULL << PWM_OUT_MIRROR_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&outputs));
    ESP_LOGI(TAG, "Early PWM outputs: GPIO%d=LOW, GPIO%d=LOW, GPIO%d=HIGH (dimming 0%%)",
             PWM_NEG_GPIO, PWM_OUT_GPIO, PWM_OUT_MIRROR_GPIO);
}

void pwm_init(void)
{
    output_mutex = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(output_mutex != NULL ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(ledc_fade_func_install(0));
    /* --- Таймер + канал для GPIO5  --- */
    ledc_timer_config_t timer_neg = {
        .speed_mode      = LEDC_MODE,
        .duty_resolution = PWM_NEG_DUTY_RES,
        .timer_num       = LEDC_TIMER_NEG,
        .freq_hz         = PWM_NEG_FREQ_HZ,
        .clk_cfg         = LEDC_USE_XTAL_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_neg));

    uint32_t neg_max_duty = (1 << PWM_NEG_DUTY_RES) - 1;               // 255
    uint32_t neg_duty = (neg_max_duty * PWM_NEG_DUTY_PERCENT) / 100;   

    ledc_channel_config_t channel_neg = {
        .gpio_num   = PWM_NEG_GPIO,
        .speed_mode = LEDC_MODE,
        .channel    = LEDC_CHANNEL_NEG,
        .timer_sel  = LEDC_TIMER_NEG,
        .duty       = neg_duty, // Start the charge pump immediately.
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel_neg));

    /* --- Таймер + канал для GPIO10 (300 Гц, duty = percent) --- */
    ledc_timer_config_t timer_out = {
        .speed_mode      = LEDC_MODE,
        .duty_resolution = PWM_OUT_DUTY_RES,
        .timer_num       = LEDC_TIMER_OUT,
        .freq_hz         = PWM_OUT_FREQ_HZ,
        .clk_cfg         = LEDC_USE_XTAL_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_out));

    ledc_channel_config_t channel_out = {
        .gpio_num   = PWM_OUT_GPIO,
        .speed_mode = LEDC_MODE,
        .channel    = LEDC_CHANNEL_OUT,
        .timer_sel  = LEDC_TIMER_OUT,
        .duty       = 0, // Hold until both direct and inverted outputs are connected.
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel_out));

    // Цей конфіг дозволяє керувати обома GPIO одночасно, використовуючи один канал PWM.
    // GPIO1 підключається до сигналу LEDC через GPIO matrix, з інверсією.
    // GPIO10 отримує прямий PWM сигнал, а GPIO1 отримує інверсний сигнал через матрицю.
    ESP_ERROR_CHECK(ledc_set_pin(PWM_OUT_MIRROR_GPIO, LEDC_MODE, LEDC_CHANNEL_OUT));
    esp_rom_gpio_connect_out_signal(PWM_OUT_MIRROR_GPIO,
                                    LEDC_LS_SIG_OUT0_IDX + LEDC_CHANNEL_OUT,
                                    true, false);

    pwm_out_set_percent(1, PWM_OUT_STARTUP_PERCENT);
    ESP_LOGI(TAG, "PWM startup: charge pump ON (%d%%), dimming %d%%; no startup delay",
             PWM_NEG_DUTY_PERCENT, PWM_OUT_STARTUP_PERCENT);

    ESP_LOGI(TAG, "PWM Ініціалізовано" );
}

/* Оновлює спільний duty на GPIO10 і GPIO1 відповідно до level (0..100) */
void pwm_out_set_percent(uint8_t channel, uint8_t level)
{

    if (channel != 1){
        return;
    }

    if (level > 100) {
        level = 100;
    }
    ESP_LOGI(TAG, "PWM надсилає відсоток: %d", level);
    uint32_t max_duty = (1 << PWM_OUT_DUTY_RES);
    uint32_t duty = (max_duty * level) / 100;

    xSemaphoreTake(output_mutex, portMAX_DELAY);
    ESP_ERROR_CHECK(ledc_fade_stop(LEDC_MODE, LEDC_CHANNEL_OUT));
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_MODE, LEDC_CHANNEL_OUT, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_MODE, LEDC_CHANNEL_OUT));
    xSemaphoreGive(output_mutex);
}

void pwm_out_fade_to_percent(uint8_t channel, uint8_t level, int duration_ms)
{
    if (channel != 1) {
        return;
    }
    if (level > 100) {
        level = 100;
    }
    uint32_t duty = ((1U << PWM_OUT_DUTY_RES) * level) / 100;

    xSemaphoreTake(output_mutex, portMAX_DELAY);
    ESP_ERROR_CHECK(ledc_fade_stop(LEDC_MODE, LEDC_CHANNEL_OUT));
    ESP_ERROR_CHECK(ledc_set_fade_with_time(LEDC_MODE, LEDC_CHANNEL_OUT, duty, duration_ms));
    ESP_ERROR_CHECK(ledc_fade_start(LEDC_MODE, LEDC_CHANNEL_OUT, LEDC_FADE_NO_WAIT));
    xSemaphoreGive(output_mutex);
}
