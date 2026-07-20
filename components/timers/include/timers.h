#pragma once

void timer_set_from_Zigbee_to_Unix(uint32_t zigbee_time);
uint32_t get_current_unix_time(void);
void timer_init(void);
uint16_t timer_get_current_time_in_minutes(void);
