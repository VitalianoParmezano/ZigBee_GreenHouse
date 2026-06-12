#include "modbus.h"
#include <stdio.h>
#include "esp_log.h"
#include "mbcontroller.h"
#include "driver/uart.h"
#include "driver/gpio.h"

// Явні дефініції пінів на випадок, якщо їх немає в Kconfig
#define MB_PORT_NUM            UART_NUM_1
#define MB_UART_TXD            GPIO_NUM_0
#define MB_UART_RXD            GPIO_NUM_1
#define MB_UART_RTS            GPIO_NUM_2 
#define MB_DEV_SPEED           (1150200) 


#define FAHOLD_SLAVE_ADDR      1 
static const char *TAG = "MODBUS";
static void *master_handle = NULL;

// ==============================================================================
// ПРИВАТНІ ХЕЛПЕРИ З МАТЕМАТИКОЮ РЕГІСТРІВ
// ==============================================================================

static int modbus_read_holding_register(uint16_t reg_addr) {
    if (!master_handle) return -1;

    mb_param_request_t req = {
        .slave_addr = FAHOLD_SLAVE_ADDR,
        .command = 0x03,  // Read Holding Registers
        .reg_start = reg_addr,
        .reg_size = 1
    };

    uint16_t reg_data = 0;
    esp_err_t err = mbc_master_send_request(master_handle, &req, &reg_data);
    return (err == ESP_OK) ? (int)reg_data : -1;
}

// ==============================================================================
// ПУБЛІЧНИЙ API (Реалізація версії 2.0)
// ==============================================================================

void modbus_init(void) {
    mb_communication_info_t comm = {
        .ser_opts.port = MB_PORT_NUM,
        .ser_opts.mode = MB_RTU,
        .ser_opts.baudrate = MB_DEV_SPEED,
        .ser_opts.parity = MB_PARITY_NONE,
        .ser_opts.uid = 0,
        .ser_opts.response_tout_ms = 1000,
        .ser_opts.data_bits = UART_DATA_8_BITS,
        .ser_opts.stop_bits = UART_STOP_BITS_1
    };

    // Ініціалізація з жорстким контролем помилок через ESP_ERROR_CHECK
    ESP_ERROR_CHECK(mbc_master_create_serial(&comm, &master_handle));
    ESP_ERROR_CHECK(uart_set_pin(MB_PORT_NUM, MB_UART_TXD, MB_UART_RXD, MB_UART_RTS, UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_set_mode(MB_PORT_NUM, UART_MODE_RS485_HALF_DUPLEX));
    ESP_ERROR_CHECK(mbc_master_start(master_handle));

    ESP_LOGI(TAG, "Modbus Master успішно запущено.");
}

void modbus_send_brightness_to_channel(uint16_t brightness, uint8_t channel) {
    if (!master_handle || channel < 1 || channel > 3) return;
    if (brightness > 1000) brightness = 1000;

    // Математика: CH1 = 0x0030, CH2 = 0x0031, CH3 = 0x0032
    uint16_t reg_addr = 0x0030 + (channel - 1);

    mb_param_request_t req = {
        .slave_addr = FAHOLD_SLAVE_ADDR,
        .command = 0x06,  // Write Single Register
        .reg_start = reg_addr,
        .reg_size = 1
    };

    ESP_LOGI(TAG, "Запис яскравості %d до каналу %d (рег. 0x%04X)", brightness, channel, reg_addr);

    esp_err_t err = mbc_master_send_request(master_handle, &req, &brightness);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка запису яскравості на CH%d", channel);
    }
}

int modbus_read_brightness_from_channel(uint8_t channel) {
    if (channel < 1 || channel > 3) return -1;
    return modbus_read_holding_register(0x0030 + (channel - 1));
}

int modbus_read_voltage_from_channel(uint8_t channel) {
    if (channel < 1 || channel > 3) return -1;
    // Математика: CH1 = 0x0040, CH2 = 0x0042, CH3 = 0x0044
    return modbus_read_holding_register(0x0040 + (channel - 1) * 2);
}

int modbus_read_current_from_channel(uint8_t channel) {
    if (channel < 1 || channel > 3) return -1;
    // Математика: CH1 = 0x0041, CH2 = 0x0043, CH3 = 0x0045
    return modbus_read_holding_register(0x0041 + (channel - 1) * 2);
}

int modbus_read_driver_temperature(void) {
    return modbus_read_holding_register(0x0017);
}