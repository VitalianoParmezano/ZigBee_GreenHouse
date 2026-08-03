#include <stdio.h>
#include "state_machine.h"

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

// ---------------------------------------------------------------------
// Обробники за типом події — по одній функції на кожен випадок.
// Тут лише прототипи + заглушки; фактичну логіку кожен наповнює сам.
// ---------------------------------------------------------------------
static void handle_attr_changed(const state_machine_event_t *evt);
static void handle_minute_tick(void);
static void handle_zigbee_online(void);
static void handle_zigbee_offline(void);

static void handle_attr_changed(const state_machine_event_t *evt)
{
    ESP_LOGI(TAG, "ATTR_CHANGED: EP%d, кластер 0x%04x, атрибут 0x%04x",
             evt->endpoint, evt->cluster_id, evt->attr_id);

    if (evt->cluster_id == 0xFC01 && evt->attr_id == 0x0001)
    {
        printf("Отримано новий розклад для каналу %d: ", evt->endpoint - 10);
        printf("Сирий розклад: ");
        for (int i = 0; i < evt->data.octet_string[0]; i++) {
            printf("%d ", evt->data.octet_string[1 + i]);
        }
        printf("\n");
    }
    
    printf("Значення отримане в чергу: %d\n", evt->data.u8_data);
}

static void handle_minute_tick(void)
{
    // TODO: інкремент локального лічильника хвилин, перевірка розкладу
    ESP_LOGD(TAG, "MINUTE_TICK");
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