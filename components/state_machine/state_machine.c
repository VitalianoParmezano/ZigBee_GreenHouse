#include <stdio.h>
#include "state_machine.h"
#include "light_driver.h"
#include "timers.h"

void func(void)
{

}
#include "state_machine.h"
#include "esp_log.h"
#include "freertos/task.h"

static const char *TAG = "STATE_MACHINE";

#define SM_QUEUE_LENGTH  16
#define SM_TASK_STACK    4096
#define SM_TASK_PRIORITY 4

static QueueHandle_t s_queue = NULL;

// Початковий стан
global_state_t g_state = {
    .current_mode = 0xff, // 0 - Manual (ручний режим за замовчуванням)
    
    .channel_timer_data = {
        {36, 0}, // Канал 1
        {36, 0}, // Канал 2
        {36, 0}  // Канал 3
    },

    .channel_offline_brightness = {50, 50, 50}
};



// ---------------------------------------------------------------------
// Обробники за типом події — по одній функції на кожен випадок.
// Тут лише прототипи + заглушки; фактичну логіку кожен наповнює сам.
// ---------------------------------------------------------------------
static void handle_attr_changed(const state_machine_event_t *evt);
//static void handle_minute_tick(void);
static void handle_zigbee_online(void);
static void handle_zigbee_offline(void);

// ОБЕРЕЖНО, тут лютєйший хардкод
// Коли до контроллера прийшла зміна атрибуту тут обробка
static void handle_attr_changed(const state_machine_event_t *evt)
{
    ESP_LOGI(TAG, "ATTR_CHANGED: EP%d, кластер 0x%04x, атрибут 0x%04x",
             evt->endpoint, evt->cluster_id, evt->attr_id);

    switch (evt->cluster_id) {
        
        case 0xFF01:
            /* Обробляються системні метадані (закріплені за ендпоінтом 2) */
            if (evt->endpoint == 2) {
                switch (evt->attr_id) {
                    case 0x0000:
                        // Статус завантаження виводиться у лог
                        ESP_LOGI(TAG, "boot_status = %d", evt->data.u8_data);
                        break;
                    case 0x0001:
                        // Поточний режим роботи фіксується
                        ESP_LOGI(TAG, "current_mode = %d", evt->data.u8_data);
                        g_state.current_mode = evt->data.u8_data; // Зберігаємо поточний режим у глобальному стані
                        break;
                    default:
                        ESP_LOGW(TAG, "Отримано невідомий атрибут системного кластера: 0x%04x", evt->attr_id);
                        break;
                }
            }
            break;

        case 0xFC01:
            /* Обробляються кастомні параметри освітлення (ендпоінти каналів) */
            if (evt->endpoint > 2) {
                switch (evt->attr_id) {
                    case 0x0000:
                        // Значення яскравості для офлайн-режиму виводиться у лог
                        ESP_LOGI(TAG, "EP%d: offline_brightness = %d", evt->endpoint, evt->data.u8_data);
                        break;
                    case 0x0001:
                        // Довжина масиву розкладу читається з нульового байта
                        ESP_LOGI(TAG, "EP%d: timer_data довжина = %d", evt->endpoint, evt->data.octet_string[0]);
                        g_state.channel_timer_data[evt->endpoint - 11][0] = evt->data.octet_string[0]; // Зберігаємо довжину розкладу у глобальному стані
                        for (int i = 0; i < evt->data.octet_string[0]; i++) {
                            g_state.channel_timer_data[evt->endpoint - 11][1 + i] = evt->data.octet_string[1 + i]; // Зберігаємо решту байтів розкладу у глобальному стані
                        }
                        printf("Канал %d мітки: ", g_state.channel_timer_data[evt->endpoint - 11][0]);
                        for(int i = 1; i <= g_state.channel_timer_data[evt->endpoint - 11][0]; i++) {
                            printf("%d ", g_state.channel_timer_data[evt->endpoint - 11][i]);
                        }
                        printf("\n");
                        break;
                    default:
                        ESP_LOGW(TAG, "Отримано невідомий атрибут кластера каналу: 0x%04x", evt->attr_id);
                        break;
                }
            }
            break;

        case 0x0006:
            /* Реєструється зміна стану увімкнення/вимкнення (On/Off) */
            if (evt->endpoint > 2) {
                ESP_LOGI(TAG, "EP%d: Змінено атрибут On/Off кластера, attr_id = 0x%04x", evt->endpoint, evt->attr_id);
            }
            break;

        case 0x0008:
            /* Реєструється зміна цільового рівня яскравості (Level Control) */
            if (evt->endpoint > 2) {
                ESP_LOGI(TAG, "EP%d: Змінено атрибут Level Control кластера, attr_id = 0x%04x", evt->endpoint, evt->attr_id);
                led_strip_set_level(evt->endpoint, evt->data.u8_data);
            }
            break;

        default:
            /* Подія для невідомого кластера ігнорується з попередженням */
            ESP_LOGW(TAG, "ATTR_CHANGED для невідомого кластера: EP%d, кластер 0x%04x", evt->endpoint, evt->cluster_id);
            break;
    }
}

void handle_minute_tick(void)
{
    ESP_LOGI(TAG, "MINUTE_TICK");
    
    if (g_state.current_mode != 1) { 
        return; 
    }
    
    uint16_t current_time = timer_get_current_time_in_minutes(); // 0 - 1439

    // channel йде від 0 до 2
    for (int channel = 0; channel < NUMBER_OF_CHANNEL_ENDPOINTS; channel++) {
        
        // Зворотна конвертація індексу в ендпоінт (0->11, 1->12, 2->13)
        uint8_t endpoint = channel + 11;
        
        uint8_t *timer_data = g_state.channel_timer_data[channel];
        uint8_t payload_length = timer_data[0]; 
        
        // Якщо розклад порожній (менше 3 байтів на одну мітку) - пропускаємо
        if (payload_length < 3) {
            continue;
        }
        
        uint16_t min_diff = 0xFFFF;
        uint16_t best_mark_time = 0;
        uint8_t best_brightness = 0;
        bool found_valid_mark = false;

        /*
         * Парсинг масиву (структура: [High Byte][Low Byte][Brightness])
         */
        for (int i = 1; i <= payload_length - 2; i += 3) {
            
            // Збираємо 16-бітний час (Little-Endian: спочатку молодший байт, потім старший)
            uint16_t mark_time = timer_data[i] | (timer_data[i + 1] << 8);
            uint8_t brightness = timer_data[i + 2];
            
            // Захист від битих міток
            if (mark_time >= 1440) {
                continue; 
            }

            // Математика кільцевого часу (перехід через добу)
            uint16_t diff = (current_time - mark_time + 1440) % 1440;
            
            // Шукаємо найближчу мітку
            if (diff < min_diff) {
                min_diff = diff;
                best_mark_time = mark_time;
                best_brightness = brightness;
                found_valid_mark = true;
            }
        }
        
        // Застосовуємо розклад до фізичного світу
        if (found_valid_mark) {
            ESP_LOGI(TAG, "EP%d: Поточний час %d хв. Найближча минула мітка: %d хв. Встановлюю яскравість %d%%", 
                     endpoint, current_time, best_mark_time, best_brightness);
                     
            led_strip_set_level(endpoint, best_brightness);
            // modbus_send_brightness_to_channel(best_brightness * 10, channel);
        } else {
            ESP_LOGW(TAG, "EP%d: Не знайдено коректних часових міток у розкладі", endpoint);
        }
    }
}

static void handle_zigbee_online(void)
{
    // TODO: зняти offline-оверрайд, повернутись до логіки поточного режиму
    ESP_LOGI(TAG, "ZIGBEE_ONLINE");
}

static void handle_zigbee_offline(void)
{
    // TODO: застосувати offline_brightness для всіх каналів
    ESP_LOGW(TAG, "ZIGBEE_OFFLINE");
}

// ---------------------------------------------------------------------
// Диспетчер: лише визначає, кому передати подію.
// ---------------------------------------------------------------------
static void state_machine_task(void *arg)
{
    state_machine_event_t event;
    ESP_LOGI(TAG, "Задача стейт-машини запущена.");

    for (;;) {
        if (xQueueReceive(s_queue, &event, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        switch (event.type) {
            case EVENT_ATTR_CHANGED:  handle_attr_changed(&event); break;
            case EVENT_MINUTE_TICK:   handle_minute_tick();        break;
            case EVENT_ZIGBEE_ONLINE: handle_zigbee_online();      break;
            case EVENT_ZIGBEE_OFFLINE:handle_zigbee_offline();     break;
            default:
                ESP_LOGW(TAG, "Невідомий тип події: %d", event.type);
                break;
        }
    }
}

void state_machine_init(void)
{
    // TODO: завантаження стану з NVS (або дефолти) — до створення задачі,
    // якщо обробники читають глобальний стан одразу після старту.

    printf("Ініціалізація стейт-машини...\n");
    printf("Розмір 1 елементу черги: %d\n", sizeof(state_machine_event_t));

    s_queue = xQueueCreate(SM_QUEUE_LENGTH, sizeof(state_machine_event_t));
    if (s_queue == NULL) {
        ESP_LOGE(TAG, "Не вдалось створити чергу.");
        return;
    }

    if (xTaskCreate(state_machine_task, "state_machine_task", SM_TASK_STACK,
                     NULL, SM_TASK_PRIORITY, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Не вдалось створити задачу стейт-машини.");
    }
}

bool state_machine_post_event(const state_machine_event_t *event)
{
    if (s_queue == NULL) {
        return false;
    }
    // Таймаут 0 — виклик очікується з задачі Zigbee-стека, блокуватись не можна.
    if (xQueueSend(s_queue, event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Чергу переповнено, подію втрачено (type=%d).", event->type);
        return false;
    }
    return true;
}