#include <stdio.h>
#include <stdint.h>
#include "PWM_control.h"
#include "light_driver.h"
#include "my_led_strip.h"
#include "modbus.h"
#include "endpoint_config.h"

// Тут закоментувати не потрібний драйвер і розкоментувати потрібний
// Кожен драйвер вимагає своєї розпіновки, обов'язково узгодити
// Піни згідно документації 
void driver_module_init_current_driver(){
    pwm_init();
    //modbus_init();
    led_strip_driver_init();
}

void set_level_of_driver_and_strip(uint8_t level, uint8_t channel)
{

    // Відправка рівня яскравості для світлодіодної стрічки
    led_strip_set_level(channel, level);

    // Відправка рівня яскравості на Modbus
    //modbus_send_brightness_to_channel(level * 10, channel);

    // Відправка рівня яскравості на PWM
    pwm_out_set_percent(channel, level);
}

void light_driver_set_offline(){
    // Встановлюємо рівень яскравості на 0 для всіх каналів (вимикаємо світло)
    int level = LIGHT_DRIVER_OFFLINE_VALUE; // Можна встановити будь-який рівень яскравості, який вважаєте за потрібне для офлайн-режиму

    for (uint8_t channel = 1; channel <= NUMBER_OF_CHANNEL_ENDPOINTS; channel++) {
        set_level_of_driver_and_strip(level, channel);
    }
}