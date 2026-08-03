#include <stdio.h>
#include "timers.h"
#include "stdint.h"
#include "endpoint_config.h"
#include "time.h"
#include "sys/time.h"
#include "esp_log.h"
#include "esp_zigbee_core.h"
#include "state_machine.h"

static const char *TAG = "TIMER";
bool time_sync_initialized = false;

uint8_t timer_seconds_to_syncronization = 0; // Лічильник секунд до синхронізації часу, потрібно для того щоб усі пристрої тікали таймером одночасно

void timer_set_time(uint32_t zigbee_time) {
    struct timeval tv = {
        .tv_sec = (time_t)zigbee_time,
        .tv_usec = 0
    };
    settimeofday(&tv, NULL);
    
    esp_zb_lock_acquire(portMAX_DELAY);
    esp_err_t err = esp_zb_zcl_set_attribute_val(
        2,
        ESP_ZB_ZCL_CLUSTER_ID_TIME,
        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
        ESP_ZB_ZCL_ATTR_TIME_TIME_ID,
        &zigbee_time,
        false
    );
    esp_zb_lock_release();

    uint8_t seconds_into_minute = zigbee_time % 60;
    timer_seconds_to_syncronization = (60 - seconds_into_minute) % 60;

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Час синхронізовано: %lu (чекаю %u сек до межі хвилини)", 
                 zigbee_time, timer_seconds_to_syncronization);
    } else {
        ESP_LOGE(TAG, "Помилка запису: %s", esp_err_to_name(err));
    }
}

uint32_t get_current_time(void) {
    // Поточний час зчитується та повертається у секундах
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint32_t)tv.tv_sec;
}

void time_sync_task(void *arg) {
    // Виконання задачі затримується на 15 секунд для завершення ініціалізації стека
    vTaskDelay(pdMS_TO_TICKS(15000));

    while (1) {
        // Поточний час зчитується з годинника мікроконтролера
        vTaskDelay(pdMS_TO_TICKS(timer_seconds_to_syncronization*1000)); // Затримка на 1 секунду для точності
        timer_seconds_to_syncronization = 0;

        time_t now;
        time(&now);

        if (now > 0) {
            // Значення часу приводиться до відповідного типу
            uint32_t zigbee_time = (uint32_t)now;

            // Атрибут часу оновлюється у фоновому режимі
            esp_zb_lock_acquire(portMAX_DELAY);
            esp_zb_zcl_set_attribute_val(
                2,
                ESP_ZB_ZCL_CLUSTER_ID_TIME,
                ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                ESP_ZB_ZCL_ATTR_TIME_TIME_ID,
                &zigbee_time,
                false
            );
            esp_zb_lock_release();

            //Надсилання стейт машині події про оновлення часу
            state_machine_event_t event = {
                .type = EVENT_MINUTE_TICK,
                .endpoint = 2,
                .cluster_id = ESP_ZB_ZCL_CLUSTER_ID_TIME,
                .attr_id = ESP_ZB_ZCL_ATTR_TIME_TIME_ID,
                .data.u8_data = 0 // Значення не використовується для цієї події
            };
            state_machine_post_event(&event);
        }
        
        // Задача призупиняється на 60 секунд
        vTaskDelay(pdMS_TO_TICKS(60000));
    }
}

uint16_t timer_get_current_time_in_minutes(void) {
    // Поточний час розраховується у хвилинах від початку доби
    struct timeval tv;
    gettimeofday(&tv, NULL);
    time_t current_time = tv.tv_sec;
    struct tm *time_info = localtime(&current_time);
    return (time_info->tm_hour * 60) + time_info->tm_min;
}

void timer_init(void) {
    // Фонова задача створюється та запускається з пріоритетом 2
    xTaskCreate(time_sync_task, "time_sync_task", 2048, NULL, 2, NULL);
}