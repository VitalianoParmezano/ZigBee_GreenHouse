#pragma once

/*
Налаштування Діп свіча, масив який визначає GPIO ключів Діп свіча, від молодшого до старшого
Знаходиться в dip_switch.c, у масиві DIP_SWITCH_GPIO_BASE. Обов'язково змінювати при переконфігурації пристрою
*/

void dip_switch_init(void);

uint8_t dip_switch_get_value(void);

void dip_switch_reset_value(void);
