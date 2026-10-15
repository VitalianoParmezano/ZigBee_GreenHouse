#include <stdio.h>
#include "PWM_control.h"
#include <stdio.h>
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_rom_gpio.h"
#include "soc/gpio_sig_map.h"

static const char *TAG = "PWM control";

void pwm_init(void)
{
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
        .duty       = neg_duty,
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
        .duty       = 0,   
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

    ESP_ERROR_CHECK(ledc_set_duty(LEDC_MODE, LEDC_CHANNEL_OUT, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_MODE, LEDC_CHANNEL_OUT));
}