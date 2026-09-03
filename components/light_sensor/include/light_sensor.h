#include <stdint.h>


#define I2C_MASTER_SCL_IO           11          /*!< GPIO number used for I2C master clock */
#define I2C_MASTER_SDA_IO           10          /*!< GPIO number used for I2C master data  */

#define I2C_MASTER_NUM              I2C_NUM_0   /*!< I2C port number for master dev */
#define I2C_MASTER_FREQ_HZ          100000      /*!< I2C master clock frequency */
#define I2C_MASTER_TIMEOUT_MS       1000

#define SENSOR_ADDR                 0x23        /*!< Address of the MPU9250 sensor */
#define SENSOR_POWER_ON_ADDR        0x1         /*!< Register addresses of the power management register */
#define SENSOR_POWER_OFF_ADDR       0x0         /*!< Register addresses of the power off register */

#define DATA_LENGTH 2                           /*!< Data length of the sensor data register. Кількість байт*/


void light_sensor_init(void);

uint16_t light_sensor_get_value(void);
void light_sensor_power_on(void);
void light_sensor_power_off(void);