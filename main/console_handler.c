#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_zigbee_core.h"
#include "ha/esp_zigbee_ha_standard.h" // Обов'язково для ZCL On/Off команд
#include "console_handler.h"

static const char *TAG = "CONSOLE_TASK";

// Визначаємо локальний ендпоінт координатора (з якого відправляємо команди)
#define HA_ONOFF_SWITCH_ENDPOINT 1 

// Масив для збереження підключених нод
#define MAX_NODES 20
static uint16_t connected_nodes[MAX_NODES];
static int node_count = 0;

// Функція для додавання ноди (викликається з app_main.c при підключенні пристрою)
void console_add_device(uint16_t short_addr) {
    // Перевіряємо, чи немає вже такої адреси в списку
    for (int i = 0; i < node_count; i++) {
        if (connected_nodes[i] == short_addr) {
            return; // Вже є, ігноруємо
        }
    }
    // Якщо є місце — додаємо
    if (node_count < MAX_NODES) {
        connected_nodes[node_count] = short_addr;
        node_count++;
        ESP_LOGI(TAG, "Ноду 0x%04x додано до списку управління (Всього: %d)", short_addr, node_count);
    } else {
        ESP_LOGW(TAG, "Список нод переповнений!");
    }
}

// Callback для отримання списку ендпоінтів
static void active_ep_cb(esp_zb_zdp_status_t zdo_status, uint8_t ep_count, uint8_t *ep_id_list, void *user_ctx) {
    uint16_t target_addr = (uint16_t)(uintptr_t)user_ctx;
    if (zdo_status == ESP_ZB_ZDP_STATUS_SUCCESS) {
        printf("\n[RESPONSE] Нода 0x%04x має %d ендпоінтів: ", target_addr, ep_count);
        for (int i = 0; i < ep_count; i++) {
            printf("%d ", ep_id_list[i]);
        }
        printf("\n");
    } else {
        ESP_LOGE(TAG, "Помилка запиту ендпоінтів для 0x%04x: %d", target_addr, zdo_status);
    }
}

// Функція для відправки команди ON/OFF (Unicast)
static void send_on_off_to_node(uint16_t target_addr, uint8_t endpoint, uint8_t command_id) {
    esp_zb_zcl_on_off_cmd_t cmd_req;
    cmd_req.zcl_basic_cmd.src_endpoint = HA_ONOFF_SWITCH_ENDPOINT;
    cmd_req.address_mode = ESP_ZB_APS_ADDR_MODE_16_BIT;
    cmd_req.dst_addr_u.addr_16 = target_addr;
    cmd_req.dst_endpoint = endpoint;
    cmd_req.on_off_cmd_id = command_id; // Наприклад: ESP_ZB_ZCL_CMD_ON_OFF_TOGGLE_ID

    esp_zb_lock_acquire(portMAX_DELAY);
    esp_zb_zcl_on_off_cmd_req(&cmd_req);
    esp_zb_lock_release();
    
    printf("Відправлено TOGGLE на 0x%04x (Ендпоінт: %d)\n", target_addr, endpoint);
}

// Основна задача консолі (нескінченний цикл)
static void console_task(void *pvParameters)
{
    char line_buffer[64];
    int current_node_index = 0;

    // Даємо трохи часу системі запуститися перед виводом меню
    vTaskDelay(pdMS_TO_TICKS(2000));

    printf("\n--- Розширена консоль координатора ---\n");
    printf(" [e] - Запитати кількість ендпоінтів у поточної ноди\n");
    printf(" [1] - Надіслати Toggle (On/Off) на поточну ноду\n");
    printf(" [s] - Статус мережі (сусіди в таблиці стека)\n");
    printf(" [+ / -] - Навігація по списку нод\n");
    printf(" [|] - Список відомих адрес\n");

    while (1) {
        if (fgets(line_buffer, sizeof(line_buffer), stdin)) {
            line_buffer[strcspn(line_buffer, "\r\n")] = 0;
            if (strlen(line_buffer) == 0) continue;

            char cmd = line_buffer[0];
            uint16_t target_addr = (node_count > 0) ? connected_nodes[current_node_index] : 0;

            // 1. Запит ендпоінтів
            if (cmd == 'e') {
                if (node_count > 0) {
                    esp_zb_zdo_active_ep_req_param_t ep_req;
                    ep_req.dst_nwk_addr = target_addr;
                    
                    printf("Запитую ендпоінти у 0x%04x...\n", target_addr);
                    esp_zb_lock_acquire(portMAX_DELAY);
                    esp_zb_zdo_active_ep_req(&ep_req, active_ep_cb, (void*)(uintptr_t)target_addr);
                    esp_zb_lock_release();
                } else {
                    printf("Немає нод у списку для запиту.\n");
                }
            }
            // 2. Команда On/Off (Toggle)
            else if (cmd == '1') {
                if (node_count > 0) {
                    // Надсилаємо на EP 1 (можна змінити або зробити динамічним)
                    send_on_off_to_node(target_addr, 1, ESP_ZB_ZCL_CMD_ON_OFF_TOGGLE_ID);
                } else {
                    printf("Немає нод у списку.\n");
                }
            }
            // 3. Перевірка реальних з'єднань (Neighbor Table)
            else if (cmd == 's') {
                printf("--- Таблиця сусідів (Stack Neighbor Table) ---\n");
                void *it = NULL;
                int count = 0;
                while ((it = esp_zb_nwk_get_next_node_info(it)) != NULL) {
                    esp_zb_node_info_t *node_info = (esp_zb_node_info_t *)it;
                    printf("Пристрій %d: Адреса: 0x%04x, Тип: %d\n", 
                            ++count, node_info->short_addr, node_info->device_type);
                }
                if (count == 0) printf("Таблиця порожня.\n");
                printf("--------------------------------------------\n");
            }
            // 4. Навігація (+)
            else if (cmd == '+') {
                if (node_count > 0) {
                    current_node_index = (current_node_index + 1) % node_count;
                    printf("Обрано ноду: 0x%04x\n", connected_nodes[current_node_index]);
                } else {
                    printf("Список порожній.\n");
                }
            }
            // 5. Навігація (-)
            else if (cmd == '-') {
                if (node_count > 0) {
                    current_node_index--;
                    if (current_node_index < 0) current_node_index = node_count - 1;
                    printf("Обрано ноду: 0x%04x\n", connected_nodes[current_node_index]);
                } else {
                    printf("Список порожній.\n");
                }
            }
            // 6. Показати список (|)
            else if (cmd == '|') {
                printf("Загалом у списку: %d нод\n", node_count);
                for (int i = 0; i < node_count; i++) {
                    printf(" %d. 0x%04x %s\n", i+1, connected_nodes[i], (i==current_node_index) ? "<-- Поточна" : "");
                }
            } else {
                printf("Невідома команда.\n");
            }
        }
        // Запобігає блокуванню ядра
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// Запуск задачі
void console_handler_start(void) {
    xTaskCreate(console_task, "console_task", 4096, NULL, 5, NULL);
}