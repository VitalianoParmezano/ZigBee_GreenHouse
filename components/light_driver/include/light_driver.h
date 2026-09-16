#define LIGHT_DRIVER_OFFLINE_VALUE 75

void set_level_of_driver_and_strip(uint8_t level, uint8_t channel);

void light_driver_set_offline(void);

void driver_module_init_current_driver(void);