#include <stdio.h>
#include "light_sensor.h"
#include "driver/i2c_master.h"

static i2c_master_dev_handle_t lux_meter_handle = NULL;

void light_sensor_init(void){

    i2c_master_bus_config_t i2c_bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,  // Джерело тактування за замовчуванням
        .i2c_port = I2C_MASTER_NUM,         // 
        .scl_io_num = I2C_MASTER_SCL_IO,    // GPIO для SCL (змініть на ваш)
        .sda_io_num = I2C_MASTER_SDA_IO,    // GPIO для SDA (змініть на ваш)
        .glitch_ignore_cnt = 7,             // Фільтрація перешкод
        .flags.enable_internal_pullup = true, // Внутрішня підтяжка
    };

    i2c_master_bus_handle_t bus_handle;
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_config, &bus_handle));

    i2c_device_config_t lux_meter_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7, // Довжина адреси 7 біт
        .device_address = SENSOR_ADDR, // Адреса сенсора
        .scl_speed_hz = I2C_MASTER_FREQ_HZ, // Частота SCL
        .scl_wait_us = 0, // Час очікування SCL
        .flags.disable_ack_check = false, // Перевірка ACK увімкнена
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus_handle, &lux_meter_config, &lux_meter_handle));

}

uint16_t light_sensor_get_value(void){
    uint8_t send_data[1] = {0b00100000}; // Адреса регістру для читання даних
    uint8_t receive_data[DATA_LENGTH]; // Буфер для отримання даних

    esp_err_t err = i2c_master_transmit_receive(lux_meter_handle, send_data, sizeof(send_data),
        receive_data, sizeof(receive_data), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        printf("I2C communication error: %d, %s\n", err, esp_err_to_name(err));
        return 0; // Повернення помилки
    }

    uint16_t lux_value = (receive_data[0] << 8) | receive_data[1]; // Об'єднання двох байтів у 16-бітне значення

    return lux_value;
}

void light_sensor_power_on(void){
    uint8_t power_on_reg[1] = {SENSOR_POWER_ON_ADDR}; // Адреса регістру "power on"
    esp_err_t err = i2c_master_transmit(lux_meter_handle, power_on_reg, sizeof(power_on_reg), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        printf("I2C communication error: %d, %s\n", err, esp_err_to_name(err));
    }
}

void light_sensor_power_off(void){
    uint8_t power_off_reg[1] = {SENSOR_POWER_OFF_ADDR}; // Адреса регістру "power off"
    esp_err_t err = i2c_master_transmit(lux_meter_handle, power_off_reg, sizeof(power_off_reg), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        printf("I2C communication error: %d, %s\n", err, esp_err_to_name(err));
    }
}
/*


    i2c_master_bus_config_t i2c_mst_config = {
    .clk_source = I2C_CLK_SRC_DEFAULT, // Джерело тактування за замовчуванням
    .i2c_port = 1, // -1 для автоматичного вибору порту
    .scl_io_num = 11, // GPIO для SCL (змініть на ваш)
    .sda_io_num = 10, // GPIO для SDA (змініть на ваш)
    .glitch_ignore_cnt = 7, // Фільтрація перешкод
    .flags.enable_internal_pullup = true, // Внутрішня підтяжка
    };

    i2c_master_bus_handle_t bus_handle;
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_mst_config, &bus_handle));

    i2c_device_config_t lux_meter_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7, // Довжина адреси 7 біт
        .device_address = 0x23, // Адреса сенсора
        .scl_speed_hz = I2C_MASTER_FREQ_HZ, // Частота SCL
        .scl_wait_us = 0, // Час очікування SCL
        .flags.disable_ack_check = false, // Перевірка ACK увімкнена
    };
    i2c_master_dev_handle_t lux_meter_handle;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus_handle, &lux_meter_config, &lux_meter_handle));

    uint8_t power_on_reg[1] = {0x1}; // Адреса регістру "who am I"
    uint8_t power_off_reg[1] = {0x0}; // Адреса регістру "who am I"


    uint8_t reg_addr[1] = {0b00100000}; // Адреса регістру для читання даних
    
    i2c_master_transmit(lux_meter_handle, power_off_reg, sizeof(power_off_reg), I2C_MASTER_TIMEOUT_MS);

    while (1)
    {
        uint8_t data_rd[DATA_LENGTH];

        ESP_ERROR_CHECK(i2c_master_transmit_receive(lux_meter_handle, reg_addr, sizeof(reg_addr),
        data_rd, sizeof(data_rd), -1));

        printf("Received data: %d %d\n", data_rd[0], data_rd[1]);
        uint16_t lux_value = (data_rd[0] << 8) | data_rd[1];
        printf("Lux value: %d\n", lux_value);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    

}
*/