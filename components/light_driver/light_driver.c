#include <stdio.h>
#include <stdint.h>
#include "PWM_control.h"
#include "light_driver.h"
#include "my_led_strip.h"
#include "modbus.h"
#include "endpoint_config.h"

// Режим і параметри задаються лише в project_config.h.
void driver_module_init_current_driver(){
#if defined(PROJECT_MODE_PWM)
    pwm_init();
#else
    modbus_init();
#endif
    led_strip_driver_init();
#if defined(PROJECT_MODE_MODBUS) && PROJECT_MODBUS_APPLY_STARTUP
    for (uint8_t channel = 1; channel <= NUMBER_OF_CHANNEL_ENDPOINTS; ++channel) {
        set_level_of_driver_and_strip(PROJECT_MODBUS_STARTUP_PERCENT, channel);
    }
#endif
}

void set_level_of_driver_and_strip(uint8_t level, uint8_t channel)
{

    // Відправка рівня яскравості для світлодіодної стрічки
    led_strip_set_level(channel, level);

    // Відправка рівня яскравості на Modbus
#if defined(PROJECT_MODE_MODBUS)
    modbus_send_brightness_to_channel(level * 10, channel);

    // Відправка рівня яскравості на PWM
#else
    pwm_out_set_percent(channel, level);
#endif
}

void light_driver_set_offline(){
    // Офлайн-рівень та час переходу PWM задані в project_config.h.
    int level = LIGHT_DRIVER_OFFLINE_VALUE; // Можна встановити будь-який рівень яскравості, який вважаєте за потрібне для офлайн-режиму

    for (uint8_t channel = 1; channel <= NUMBER_OF_CHANNEL_ENDPOINTS; channel++) {
        led_strip_set_level(channel, level);
#if defined(PROJECT_MODE_PWM)
        pwm_out_fade_to_percent(channel, level, PROJECT_PWM_OFFLINE_FADE_MS);
#else
        modbus_send_brightness_to_channel(level * 10, channel);
#endif
    }
}
