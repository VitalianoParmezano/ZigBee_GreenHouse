#include "modbus.h"
#include <stdio.h>
#include "esp_log.h"
#include "mbcontroller.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "string.h"
#include "stdlib.h"


// Явні дефініції пінів на випадок, якщо їх немає в Kconfig
#define MB_PORT_NUM            UART_NUM_1
#define MB_UART_TXD            GPIO_NUM_0
#define MB_UART_RXD            GPIO_NUM_1
#define MB_UART_RTS            GPIO_NUM_2 
#define MB_DEV_SPEED           115200 

typedef struct {
    // 0x0017 - Температура (Увага: може не підтримуватися на прошивці A03, повертає таймаут)
    uint16_t driver_temp;     

    uint16_t brightness_ch1;  // 0x0030 - Яскравість CH1
    uint16_t brightness_ch2;  // 0x0031 - Яскравість CH2
    uint16_t brightness_ch3;  // 0x0032 - Яскравість CH3

    uint16_t voltage_ch1;     // 0x0040 - Напруга CH1
    uint16_t current_ch1;     // 0x0041 - Струм CH1

    uint16_t voltage_ch2;     // 0x0042 - Напруга CH2
    uint16_t current_ch2;     // 0x0043 - Струм CH2

    uint16_t voltage_ch3;     // 0x0044 - Напруга CH3
    uint16_t current_ch3;     // 0x0045 - Струм CH3
} holding_reg_params_t;

holding_reg_params_t holding_reg_params = { 0 };

#define MASTER_MAX_CIDS num_device_parameters
#define HOLD_OFFSET(field) ((uint16_t)(offsetof(holding_reg_params_t, field) + 1))
#define STR(fieldname) ((const char *)( fieldname ))
#define OPTS(min_val, max_val, step_val) { .opt1 = min_val, .opt2 = max_val, .opt3 = step_val }


#define FAHOLD_SLAVE_ADDR      1 
static const char *TAG = "MODBUS";
static void *master_handle = NULL;

enum { MB_DEVICE_ADDR1 = 1 };

enum {
    CID_TEMP = 0,
    CID_BRIGHTNESS_CH1, CID_BRIGHTNESS_CH2, CID_BRIGHTNESS_CH3,
    CID_VOLTAGE_CH1, CID_CURRENT_CH1,
    CID_VOLTAGE_CH2, CID_CURRENT_CH2,
    CID_VOLTAGE_CH3, CID_CURRENT_CH3,
    CID_COUNT
};


const mb_parameter_descriptor_t device_parameters[] = {
    { CID_TEMP, STR("Temp"), STR("C"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0017, 1, HOLD_OFFSET(driver_temp), PARAM_TYPE_U16, 2, OPTS( 0, 120, 0 ), PAR_PERMS_READ },
    
    { CID_BRIGHTNESS_CH1, STR("B_CH1"), STR("0.1%"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0030, 1, HOLD_OFFSET(brightness_ch1), PARAM_TYPE_U16, 2, OPTS( 0, 1000, 1 ), PAR_PERMS_READ_WRITE_TRIGGER },
    { CID_BRIGHTNESS_CH2, STR("B_CH2"), STR("0.1%"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0031, 1, HOLD_OFFSET(brightness_ch2), PARAM_TYPE_U16, 2, OPTS( 0, 1000, 1 ), PAR_PERMS_READ_WRITE_TRIGGER },
    { CID_BRIGHTNESS_CH3, STR("B_CH3"), STR("0.1%"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0032, 1, HOLD_OFFSET(brightness_ch3), PARAM_TYPE_U16, 2, OPTS( 0, 1000, 1 ), PAR_PERMS_READ_WRITE_TRIGGER },

    { CID_VOLTAGE_CH1, STR("V_CH1"), STR("0.1V"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0040, 1, HOLD_OFFSET(voltage_ch1), PARAM_TYPE_U16, 2, OPTS( 0, 3000, 0 ), PAR_PERMS_READ },
    { CID_CURRENT_CH1, STR("I_CH1"), STR("0.1mA"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0041, 1, HOLD_OFFSET(current_ch1), PARAM_TYPE_U16, 2, OPTS( 0, 6000, 0 ), PAR_PERMS_READ },

    { CID_VOLTAGE_CH2, STR("V_CH2"), STR("0.1V"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0042, 1, HOLD_OFFSET(voltage_ch2), PARAM_TYPE_U16, 2, OPTS( 0, 3000, 0 ), PAR_PERMS_READ },
    { CID_CURRENT_CH2, STR("I_CH2"), STR("0.1mA"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0043, 1, HOLD_OFFSET(current_ch2), PARAM_TYPE_U16, 2, OPTS( 0, 6000, 0 ), PAR_PERMS_READ },

    { CID_VOLTAGE_CH3, STR("V_CH3"), STR("0.1V"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0044, 1, HOLD_OFFSET(voltage_ch3), PARAM_TYPE_U16, 2, OPTS( 0, 3000, 0 ), PAR_PERMS_READ },
    { CID_CURRENT_CH3, STR("I_CH3"), STR("0.1mA"), MB_DEVICE_ADDR1, MB_PARAM_HOLDING, 0x0045, 1, HOLD_OFFSET(current_ch3), PARAM_TYPE_U16, 2, OPTS( 0, 6000, 0 ), PAR_PERMS_READ }
};
const uint16_t num_device_parameters = (sizeof(device_parameters) / sizeof(device_parameters[0]));

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
    
    mbc_master_set_descriptor(master_handle, &device_parameters[0], num_device_parameters);

    ESP_ERROR_CHECK(mbc_master_start(master_handle));

    ESP_LOGI(TAG, "Modbus Master успішно запущено.");
}

void modbus_send_brightness_to_channel(uint16_t brightness, uint8_t channel) {
    // if (!master_handle || channel < 1 || channel > 3) return;
    if (brightness > 1000) brightness = 1000;

    // // Математика: CH1 = 0x0030, CH2 = 0x0031, CH3 = 0x0032
    // uint16_t reg_addr = 0x0030 + (channel - 1);

    // mb_param_request_t req = {
    //     .slave_addr = FAHOLD_SLAVE_ADDR,
    //     .command = 0x06,  // Write Single Register
    //     .reg_start = reg_addr,
    //     .reg_size = 1
    // };

    // ESP_LOGI(TAG, "Запис яскравості %d до каналу %d (рег. 0x%04X)", brightness, channel, reg_addr);

    // esp_err_t err = mbc_master_send_request(master_handle, &req, &brightness);
    // if (err != ESP_OK) {
    //     ESP_LOGE(TAG, "Помилка запису яскравості на CH%d", channel);
    // }
    ESP_LOGI(TAG, "Запис яскравості %d до каналу %d", brightness, channel);

    uint16_t cid = (channel == 1) ? CID_BRIGHTNESS_CH1 : (channel == 2) ? CID_BRIGHTNESS_CH2 : CID_BRIGHTNESS_CH3;


    uint8_t write_type = 0;
    mbc_master_set_parameter(master_handle, cid, (uint8_t*)&brightness, &write_type); 

    ESP_LOGI(TAG, "Параметр CID %d відправлено через mbc_master_set_parameter", cid);
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