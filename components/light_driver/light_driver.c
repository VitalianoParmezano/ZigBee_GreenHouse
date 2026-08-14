#include <stdio.h>
#include <stdint.h>
#include "light_driver.h"
#include "my_led_strip.h"
#include "modbus.h"

void set_level_of_driver_and_strip(uint8_t level, uint8_t channel)
{

    // Відправка рівня яскравості для світлодіодної стрічки
    led_strip_set_level(channel, level);

    // Відправка рівня яскравості на Modbus
    modbus_send_brightness_to_channel(level * 10, channel);
}

void light_driver_set_offline(){
    // Встановлюємо рівень яскравості на 0 для всіх каналів (вимикаємо світло)
    int level = 75; // Можна встановити будь-який рівень яскравості, який вважаєте за потрібне для офлайн-режиму
    for (uint8_t channel = 11; channel <= 13; channel++) {
        led_strip_set_level(channel, level);
        modbus_send_brightness_to_channel(level * 10, channel%10);
    }
}