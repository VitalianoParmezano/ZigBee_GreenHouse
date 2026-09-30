#include <stdint.h>
#include "esp_err.h"

#define I2C_MASTER_SCL_IO           11          /*!< GPIO для SCL */
#define I2C_MASTER_SDA_IO           10          /*!< GPIO для SDA */

#define I2C_MASTER_NUM              I2C_NUM_0   /*!< Номер порту I2C */
#define I2C_MASTER_FREQ_HZ          100000      /*!< Частота I2C (100 кГц) */
#define I2C_MASTER_TIMEOUT_MS       1000

#define SENSOR_ADDR                 0x23        /*!< I2C адреса сенсора*/
#define SENSOR_POWER_ON_ADDR        0x01        /*!< Команда увімкнення (Power On) */
#define SENSOR_POWER_OFF_ADDR       0x00        /*!< Команда вимкнення (Power Down) */

#define DATA_LENGTH                 2           /*!< Кількість байт для вичитування */

/* 
 * 0b00010000 (0x10) — Continuous H-Resolution Mode:
 * Датчик автоматично вимірює освітленість у фоні кожні 120 мс
 */
#define SENSOR_ADDR_START_MEASUREMENT  0b00010000

void light_sensor_init(void);
void light_sensor_power_on(void);
void light_sensor_power_off(void);
uint16_t light_sensor_get_value(void);