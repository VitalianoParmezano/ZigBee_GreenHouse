#pragma once

#define BUTTON_GPIO 22
#define LONG_PRESS_TIME_MS 5000
#define SHORT_PRESS_TIME_MS 50

/*
Налаштування Діп свіча, масив який визначає GPIO ключів Діп свіча, від молодшого до старшого
Знаходиться в dip_switch.c, обов'язково змінювати при переконфігурації пристрою
*/

void init_reset_configuration();

