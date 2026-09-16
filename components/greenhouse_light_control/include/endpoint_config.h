#pragma once

#include "esp_zigbee_core.h"
#include "esp_log.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ESP_MANUFACTURER_NAME "\x03""ESV" 
#define ESP_MODEL_ID          "\x18""Greenhouse_Controller_v1" // \x18 це 24 в HEX

// SHIFT вказує на скільки ендпоінти каналів відрізняються від базового, тобто якщо значення 10, то 1 зона 1 канал буде 11 ендпоінт
#define SHIFT 10 // Зсув для номерів ендпоінтів каналів (щоб не перетинатися з базовим ендпоінтом)

#define NUMBER_OF_CHANNEL_ENDPOINTS 3 // Кількість ендпоінтів для каналів 


uint8_t get_boot_status(void);


void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list);
void assign_internal_groups_after_join(void);

#ifdef __cplusplus
}
#endif