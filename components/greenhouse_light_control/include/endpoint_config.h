#include "esp_zigbee_core.h"
#include "esp_log.h"

#ifdef __cplusplus
extern "C" {
#endif

#define NUMBER_OF_CHANNEL_ENDPOINTS 3 // Кількість ендпоінтів для каналів 

void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list);

#ifdef __cplusplus
}
#endif