#pragma once

// Виберіть РІВНО ОДИН режим: закоментуйте поточний і розкоментуйте потрібний.
#define PROJECT_MODE_PWM
// #define PROJECT_MODE_MODBUS

#if defined(PROJECT_MODE_PWM) == defined(PROJECT_MODE_MODBUS)
#error "Select exactly one mode: PROJECT_MODE_PWM or PROJECT_MODE_MODBUS"
#endif

// PWM: канал 1, прямий вихід та його інвертована копія.
#define PROJECT_PWM_GPIO 10
#define PROJECT_PWM_INVERTED_GPIO 1
#define PROJECT_PWM_FREQUENCY_HZ 300
#define PROJECT_PWM_STARTUP_PERCENT 99
#define PROJECT_CHARGE_PUMP_GPIO 5
#define PROJECT_CHARGE_PUMP_FREQUENCY_HZ 100000
#define PROJECT_CHARGE_PUMP_PERCENT 50

// Modbus RTU / MAX485. Адреса 0 — broadcast, як у modbus_testing.
#define PROJECT_MODBUS_TX_GPIO 0
#define PROJECT_MODBUS_RX_GPIO 1
#define PROJECT_MODBUS_RTS_GPIO 2
#define PROJECT_MODBUS_BAUDRATE 115200
#define PROJECT_MODBUS_ADDRESS 0
#define PROJECT_MODBUS_RESPONSE_TIMEOUT_MS 1
// 0: не надсилати стартову яскравість (залишити стан драйвера).
#define PROJECT_MODBUS_APPLY_STARTUP 0
#define PROJECT_MODBUS_STARTUP_PERCENT 100

// Спільний офлайн-рівень; плавність нижче застосовується до PWM.
#define PROJECT_OFFLINE_PERCENT 100
#define PROJECT_PWM_OFFLINE_FADE_MS 10000
#define PROJECT_SERVER_TIMEOUT_US 180000000ULL

#if PROJECT_PWM_STARTUP_PERCENT > 100 || PROJECT_MODBUS_STARTUP_PERCENT > 100 || \
    PROJECT_OFFLINE_PERCENT > 100 || PROJECT_CHARGE_PUMP_PERCENT > 100
#error "Brightness and duty percentages must be in range 0..100"
#endif
