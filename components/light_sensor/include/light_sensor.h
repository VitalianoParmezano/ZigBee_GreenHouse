#include <stdint.h>
#include "driver/i2c.h"

void light_sensor_init(void);

uint16_t light_sensor_get_value(void);
