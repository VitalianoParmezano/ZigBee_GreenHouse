#include <stdio.h>
#include "timers.h"
#include "stdint.h"
#include "endpoint_config.h"

#include "time.h"
#include "sys/time.h"
#include "esp_log.h"

#define ESP_ZB_TIME_OFFSET 946684800 // Різниця між епохою Unix (1970) та епохою Zigbee (2000) у секундах

static const char *TAG = "TIMER";
bool time_sync_initialized = false;

// TODO: НАЛАШТУВАТИ ЧАСОВИЙ ПОЯС
void timer_set_from_Zigbee_to_Unix(uint32_t zigbee_time) {
    uint32_t unix_time = zigbee_time + ESP_ZB_TIME_OFFSET;

    // Системний час ESP32 встановлюється на основі отриманого Unix-часу
    struct timeval tv = {
        .tv_sec = (time_t)unix_time,
        .tv_usec = 0
    };
    settimeofday(&tv, NULL);
    ESP_LOGI(TAG, "Час синхронізовано Unix: %lu", unix_time);

    // Локальний час зчитується з системного годинника
    time_t now;
    time(&now);
    struct tm *timeinfo = localtime(&now);
    
    // Значення записується в локальну таблицю атрибутів Zigbee.
    // Захоплюється блокування (mutex), оскільки модифікація пам'яті виконується поза контекстом головного циклу
    esp_zb_lock_acquire(portMAX_DELAY);
    
    esp_err_t err = esp_zb_zcl_set_attribute_val(
        2,                                // Ендпоінт (метаданні ЕП 2)
        ESP_ZB_ZCL_CLUSTER_ID_TIME,       // ID кластера (або)
        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,   // Роль кластера (сервер)
        ESP_ZB_ZCL_ATTR_TIME_TIME_ID,                           // ID атрибута (device_time)
        &zigbee_time,                     // Вказівник на буфер з даними
        false                             // Виклик локального колбека блокується для запобігання зацикленню
    );
    
    esp_zb_lock_release();

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Атрибут часу успішно оновлено: %lu хв (%.2d:%.2d)", 
                 zigbee_time, timeinfo->tm_hour, timeinfo->tm_min);
    } else {
        ESP_LOGE(TAG, "Помилка запису в атрибут часу: %s", esp_err_to_name(err));
    }
}

uint32_t get_current_unix_time(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint32_t)tv.tv_sec;
}

void time_sync_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(15000));

    while (1) {
        request_time_from_coordinator();

        if (time(NULL) > 946684800UL) {
            ESP_LOGI("TIME_TASK", "Синхронізовано, наступна синхронізація через 12 годин.");
            vTaskDelay(pdMS_TO_TICKS(43200000UL)); 
        } else {
            ESP_LOGW("TIME_TASK", "Час не наведено. Повтор через 1 хвилину.");
            vTaskDelay(pdMS_TO_TICKS(60000UL));
        }
    }
}

uint16_t timer_get_current_time_in_minutes(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    time_t current_time = tv.tv_sec;
    struct tm *time_info = localtime(&current_time);
    uint16_t minutes_since_midnight = time_info->tm_hour * 60 + time_info->tm_min;
    return minutes_since_midnight;
}



void timer_init(void) {
    ESP_LOGI(TAG, "Ініціалізація таймера.");
    xTaskCreate(time_sync_task, "time_sync_task", 2048, NULL, 5, NULL);
}