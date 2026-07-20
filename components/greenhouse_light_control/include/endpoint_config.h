#include "esp_zigbee_core.h"
#include "esp_log.h"

#ifdef __cplusplus
extern "C" {
#endif

#define NUMBER_OF_CHANNEL_ENDPOINTS 3 // Кількість   для каналів 
#define SHIFT 10 // Зсув для номерів ендпоінтів каналів (11 - перша зона 1 канал, 23 друга зона третій канал).

void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list);
void assign_internal_groups_after_join(void);
void request_time_from_coordinator(void);


// Структура чаосової мітки
typedef struct {
    uint16_t minute;         // 2 байти (Час у хвилинах, 0-1439)
    uint8_t brightness;      // 1 байт (Відсоток, 0-100)
} ESP_ZB_PACKED_STRUCT time_mark_t;

#ifdef __cplusplus
}
#endif