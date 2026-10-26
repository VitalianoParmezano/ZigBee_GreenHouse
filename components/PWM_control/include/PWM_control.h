#pragma once
#include "project_config.h"
#define PWM_OUT_STARTUP_PERCENT PROJECT_PWM_STARTUP_PERCENT
#include <stdint.h>


#define PWM_NEG_GPIO         PROJECT_CHARGE_PUMP_GPIO
#define PWM_NEG_FREQ_HZ      PROJECT_CHARGE_PUMP_FREQUENCY_HZ              // 100 кГц
#define PWM_NEG_DUTY_RES     LEDC_TIMER_8_BIT     // 0..255
#define PWM_NEG_DUTY_PERCENT PROJECT_CHARGE_PUMP_PERCENT                   // 50% — потрібно для перемикання charge pump!

// GPIO10 — прямий PWM, дає сигнал на перший світильник
#define PWM_OUT_GPIO        PROJECT_PWM_GPIO
// GPIO1 — інверсний через GPIO matrix, дає сигнал на декодер
#define PWM_OUT_MIRROR_GPIO PROJECT_PWM_INVERTED_GPIO
#define PWM_OUT_FREQ_HZ     PROJECT_PWM_FREQUENCY_HZ                  // 300 Гц
#define PWM_OUT_DUTY_RES     LEDC_TIMER_10_BIT    // 0-1023

#define LEDC_TIMER_NEG       LEDC_TIMER_0
#define LEDC_TIMER_OUT       LEDC_TIMER_1
#define LEDC_CHANNEL_NEG     LEDC_CHANNEL_0
#define LEDC_CHANNEL_OUT     LEDC_CHANNEL_3
#define LEDC_MODE            LEDC_LOW_SPEED_MODE  // ESP32-H2 підтримує лише low-speed mode


void pwm_init(void);
// Call first in app_main(), before peripheral initialization.
void pwm_prepare_startup_outputs(void);

void pwm_out_set_percent(uint8_t channel, uint8_t level);
void pwm_out_fade_to_percent(uint8_t channel, uint8_t level, int duration_ms);

