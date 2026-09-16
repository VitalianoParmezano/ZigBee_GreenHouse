//Значення яке буде застосовано у випадку відсутності з'єднання

/*
    Коли переконфігуровується прошивка обов'язково переглянути файл light_driver.c
    І підставити ті команди які треба конкретному проекту.
*/

#define LIGHT_DRIVER_OFFLINE_VALUE 75

void set_level_of_driver_and_strip(uint8_t level, uint8_t channel);

void light_driver_set_offline(void);

void driver_module_init_current_driver(void);