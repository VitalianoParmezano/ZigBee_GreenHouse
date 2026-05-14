#pragma once

#include "esp_err.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Ініціалізація ШІМ-контролера для всіх каналів світла
 */
void light_driver_init(void);

/**
 * @brief Встановлення яскравості для конкретного ендпоінта
 * @param endpoint_id ID ендпоінта (1, 2, 3...)
 * @param brightness Яскравість (0-254)
 */
void light_driver_set_level(int endpoint_id, uint8_t brightness);

#ifdef __cplusplus
}
#endif