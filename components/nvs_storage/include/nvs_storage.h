#pragma once

#include <stdint.h>
#include "esp_err.h"

// Ініціалізує NVS flash. Викликати один раз при старті, до write/read.
esp_err_t nvs_storage_init(void);

// Записує offline_brightness для каналу (channel: 0-2) у NVS.
esp_err_t nvs_write_offline_brightness(uint8_t channel, uint8_t value);

// Читає offline_brightness для каналу (channel: 0-2) з NVS.
// Якщо значення ще не збережено — повертає default_value.
uint8_t nvs_read_offline_brightness(uint8_t channel, uint8_t default_value);