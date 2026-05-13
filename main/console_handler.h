#ifndef CONSOLE_HANDLER_H
#define CONSOLE_HANDLER_H

#include <stdint.h>

// Функція для запуску задачі консолі
void console_handler_start(void);

// Функція для додавання знайденої ноди до нашого списку (викликати з main.c)
void console_add_device(uint16_t short_addr);

#endif // CONSOLE_HANDLER_H