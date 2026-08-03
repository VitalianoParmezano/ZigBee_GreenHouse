#ifndef STATE_MACHINE_H
#define STATE_MACHINE_H

#include <stdint.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

typedef enum {
    EVENT_ZIGBEE_ONLINE,
    EVENT_ZIGBEE_OFFLINE,
    EVENT_ATTR_CHANGED,
    EVENT_MINUTE_TICK,
} event_type_t;

// Подія не несе копії значення атрибута — воно вже лежить у спільній
// пам'яті на момент, коли подія доходить до обробника.
typedef struct {
    event_type_t type;
    uint8_t  endpoint;   // актуально лише для EVENT_ATTR_CHANGED
    uint16_t cluster_id;
    uint16_t attr_id;

    union {
        uint8_t u8_data;
        uint8_t octet_string[37];
    } data;
} state_machine_event_t;

void state_machine_init(void);

// Відправка — безпечна для виклику з задачі Zigbee-стека.
bool state_machine_post_event(const state_machine_event_t *event);



#endif // STATE_MACHINE_H