#include <stdio.h>
#include <stdint.h>
#include "heart_beat.h"
#include "esp_log.h"
#include "esp_zigbee_core.h"
#include "esp_timer.h"
#include "esp_random.h"

static const char *TAG = "HEART_BEAT";

// Дескриптори таймерів
static esp_timer_handle_t ping_timer = NULL;
static esp_timer_handle_t watchdog_timer = NULL;

// Налаштування інтервалів (у мікросекундах)
#define PING_BASE_INTERVAL_US    50000000ULL // 50 секунд
#define PING_RANDOM_WINDOW_US    20000000ULL // + до 20 секунд (разом 50-70 сек)
#define WATCHDOG_TIMEOUT_US      180000000ULL // 3 хвилини (180 сек) без відповіді = Офлайн

// Попереднє оголошення функцій
static void send_boot_status_report(uint8_t status_value);
static void start_next_ping_timer(void);

// =========================================================
// 1. АВТОНОМНИЙ РЕЖИМ (Колбек сторожового таймера)
// =========================================================
static void watchdog_timeout_callback(void* arg) {
    ESP_LOGE(TAG, "ВТРАЧЕНО ЗВ'ЯЗОК ІЗ СЕРВЕРОМ! Сервер не відповідає більше 3 хвилин.");
    
    // TODO: Тут викликай функцію переходу в офлайн-режим
    // Наприклад: activate_phytolighting_offline_mode();
}

// =========================================================
// 2. ВІДПРАВКА PING (Колбек таймера серцебиття)
// =========================================================
static void ping_timer_callback(void* arg) {
    ESP_LOGI(TAG, "Відправка Ping (boot_status = 2) на сервер...");
    
    // Відправляємо двійку (просимо підтвердження)
    send_boot_status_report(2);
    
    // Запускаємо цей самий таймер на наступний випадковий інтервал
    start_next_ping_timer();
}

// Функція для розрахунку наступного випадкового інтервалу
static void start_next_ping_timer(void) {
    if (ping_timer == NULL) return;
    
    // Генеруємо випадковий інтервал від 50 до 70 секунд
    uint64_t next_delay = PING_BASE_INTERVAL_US + (esp_random() % PING_RANDOM_WINDOW_US);
    
    esp_timer_start_once(ping_timer, next_delay);
    ESP_LOGI(TAG, "Наступний Ping заплановано через %llu секунд", next_delay / 1000000ULL);
}

// =========================================================
// ОТРИМАННЯ PONG ВІД СЕРВЕРА
// =========================================================
void heart_beat_input_value(uint8_t value) {
    // Сервер має повертати 1 (Синхронізовано)
    if (value == 1) {
        ESP_LOGI(TAG, "Отримано Pong (%d) від сервера! Зв'язок стабільний.", value);
        
        // Скидаємо сторожовий таймер (відміняємо тривогу і заводимо наново)
        if (watchdog_timer != NULL) {
            esp_timer_stop(watchdog_timer);
            esp_timer_start_once(watchdog_timer, WATCHDOG_TIMEOUT_US);
        }
    } else {
        ESP_LOGW(TAG, "Отримано невідомий статус: %d", value);
    }
}

// =========================================================
// ІНІЦІАЛІЗАЦІЯ (Викликати один раз при старті плати)
// =========================================================
void heart_beat_init(void) {
    // Створюємо таймер для Ping
    const esp_timer_create_args_t ping_timer_args = {
        .callback = &ping_timer_callback,
        .name = "ping_timer"
    };
    esp_timer_create(&ping_timer_args, &ping_timer);

    // Створюємо таймер для Watchdog
    const esp_timer_create_args_t watchdog_timer_args = {
        .callback = &watchdog_timeout_callback,
        .name = "watchdog_timer"
    };
    esp_timer_create(&watchdog_timer_args, &watchdog_timer);

    // Запускаємо процес (перший пінг через випадковий час і запуск вочдога)
    start_next_ping_timer();
    esp_timer_start_once(watchdog_timer, WATCHDOG_TIMEOUT_US);
    
    ESP_LOGI(TAG, "Система серцебиття та Watchdog успішно запущені!");
}

// =========================================================
// УНІВЕРСАЛЬНА ФУНКЦІЯ ВІДПРАВКИ ZCL РЕПОРТУ
// =========================================================
static void send_boot_status_report(uint8_t status_value) {
    esp_zb_lock_acquire(portMAX_DELAY);

    // Записуємо локально
    esp_err_t err = esp_zb_zcl_set_attribute_val(
        2, 0xFF01,
        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, 
        0x0000, &status_value, false
    );

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка запису в локальний атрибут: %s", esp_err_to_name(err));
        esp_zb_lock_release();
        return;
    }

    // Формуємо радіопакет
    esp_zb_zcl_report_attr_cmd_t report_cmd = {
        .zcl_basic_cmd = {
            .dst_addr_u.addr_short = 0x0000,
            .dst_endpoint = 1,
            .src_endpoint = 2,
        },
        .address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT,
        .clusterID = 0xFF01,
        .attributeID = 0x0000,
        .direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_CLI,
        .dis_default_resp = 0,
        .manuf_specific = 0,
        .manuf_code = ESP_ZB_ZCL_ATTR_NON_MANUFACTURER_SPECIFIC
    };
    
    err = esp_zb_zcl_report_attr_cmd_req(&report_cmd);
    esp_zb_lock_release();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка відправки радіопакета: %s", esp_err_to_name(err));
    }
}