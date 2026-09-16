#ifndef MODBUS_H
#define MODBUS_H


/* Явні дефініції пінів для modbus
    Передаються дані по UART на мікросхему MAX485,
    тут усі піни які треба для цього
*/
#define MB_PORT_NUM            UART_NUM_1
#define MB_UART_TXD            GPIO_NUM_0
#define MB_UART_RXD            GPIO_NUM_1
#define MB_UART_RTS            GPIO_NUM_2 
#define MB_DEV_SPEED           115200 

#include <stdint.h>

/**
 * @brief Ініціалізація Modbus Master для 3-канального драйвера Fahold
 */
void modbus_init(void);

/**
 * @brief Встановлення яскравості для конкретного каналу
 * @param brightness Значення (0 - 1000, що відповідає 0.0% - 100.0%)
 * @param channel Номер каналу (1, 2 або 3)
 */
void modbus_send_brightness_to_channel(uint16_t brightness, uint8_t channel);

/**
 * @brief Читання поточної яскравості з каналу
 * @return Значення 0-1000, або -1 у разі помилки зв'язку
 */
int modbus_read_brightness_from_channel(uint8_t channel);

/**
 * @brief Читання напруги з каналу (в десяткових частках, напр. 240 = 24.0V)
 * @return Значення напруги, або -1 у разі помилки
 */
int modbus_read_voltage_from_channel(uint8_t channel);

/**
 * @brief Читання струму з каналу (в десятих частках мА)
 * @return Значення струму, або -1 у разі помилки
 */
int modbus_read_current_from_channel(uint8_t channel);

/**
 * @brief Читання внутрішньої температури драйвера Fahold
 * @return Температура в градусах Цельсія, або -1 у разі помилки
 */
int modbus_read_driver_temperature(void);

#endif // MODBUS_H