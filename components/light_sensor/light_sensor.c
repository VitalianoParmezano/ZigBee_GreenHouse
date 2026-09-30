#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "light_sensor.h"

static const char *TAG_SENSOR = "LIGHT_SENSOR";
static i2c_master_dev_handle_t lux_meter_handle = NULL;

void light_sensor_init(void) {
    i2c_master_bus_config_t i2c_bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_MASTER_NUM,
        .scl_io_num = I2C_MASTER_SCL_IO,
        .sda_io_num = I2C_MASTER_SDA_IO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };

    i2c_master_bus_handle_t bus_handle;
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_config, &bus_handle));

    i2c_device_config_t lux_meter_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = SENSOR_ADDR,
        .scl_speed_hz = I2C_MASTER_FREQ_HZ,
        .scl_wait_us = 0,
        .flags.disable_ack_check = false,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus_handle, &lux_meter_config, &lux_meter_handle));
    
    // ОБОВ'ЯЗКОВА ПАУЗА: даємо напрузі на лініях I2C стабілізуватися після старту
    vTaskDelay(pdMS_TO_TICKS(150));
}

void light_sensor_power_on(void) {
    // Просто будимо датчик (0x01)
    uint8_t power_on_cmd[1] = {SENSOR_POWER_ON_ADDR};
    esp_err_t err = i2c_master_transmit(lux_meter_handle, power_on_cmd, sizeof(power_on_cmd), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG_SENSOR, "I2C power on error: %s", esp_err_to_name(err));
    }
}

void light_sensor_power_off(void) {
    uint8_t power_off_cmd[1] = {SENSOR_POWER_OFF_ADDR};
    esp_err_t err = i2c_master_transmit(lux_meter_handle, power_off_cmd, sizeof(power_off_cmd), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG_SENSOR, "I2C power off error: %s", esp_err_to_name(err));
    }
}

uint16_t light_sensor_get_value(void) {
    uint8_t send_data[1] = {SENSOR_ADDR_START_MEASUREMENT};
    uint8_t receive_data[DATA_LENGTH] = {0};

    // 1. Посилаємо команду на початок вимірювання (ОДНОРАЗОВО)
    esp_err_t err = i2c_master_transmit(lux_meter_handle, send_data, sizeof(send_data), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG_SENSOR, "I2C transmit error: %s", esp_err_to_name(err));
        return 0;
    }

    // 2. Даємо датчику BH1750 час на накопичення світла (180 мс)
    vTaskDelay(pdMS_TO_TICKS(180));

    // 3. Зчитуємо готовий результат
    err = i2c_master_receive(lux_meter_handle, receive_data, sizeof(receive_data), I2C_MASTER_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG_SENSOR, "I2C receive error: %s", esp_err_to_name(err));
        return 0;
    }

    return (receive_data[0] << 8) | receive_data[1];
}