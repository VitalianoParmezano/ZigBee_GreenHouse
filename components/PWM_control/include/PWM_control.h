#pragma once
#include <stdint.h>


#define PWM_NEG_GPIO         5
#define PWM_NEG_FREQ_HZ      100000              // 100 кГц
#define PWM_NEG_DUTY_RES     LEDC_TIMER_8_BIT     // 0..255
#define PWM_NEG_DUTY_PERCENT 50                   // 50% — потрібно для перемикання charge pump!

// GPIO10 — прямий PWM, дає сигнал на перший світильник
#define PWM_OUT_GPIO        10
// GPIO1 — інверсний через GPIO matrix, дає сигнал на декодер
#define PWM_OUT_MIRROR_GPIO 1                     // 
#define PWM_OUT_FREQ_HZ     300                  // 300 Гц
#define PWM_OUT_DUTY_RES     LEDC_TIMER_10_BIT    // 0-1023

#define LEDC_TIMER_NEG       LEDC_TIMER_0
#define LEDC_TIMER_OUT       LEDC_TIMER_1
#define LEDC_CHANNEL_NEG     LEDC_CHANNEL_0
#define LEDC_CHANNEL_OUT     LEDC_CHANNEL_3
#define LEDC_MODE            LEDC_LOW_SPEED_MODE  // ESP32-H2 підтримує лише low-speed mode


void pwm_init(void);

void pwm_out_set_percent(uint8_t channel, uint8_t level);
void pwm_out_fade_to_percent(uint8_t channel, uint8_t level, int duration_ms);

