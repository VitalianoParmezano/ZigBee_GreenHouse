#include "endpoint_config.h"             // Файл з функцією для створення списку ендпоінтів пристрою
#include "light_driver.h"              // Файл з функцією для ініціалізації драйвера світла та встановлення рівня яскравості
#include "reset_configuration.h"         // Файл з функцією для налаштування кнопки скидання
#include "dip_switch.h"
#include "esp_zb_switch.h"             // Заголовочний файл з конфігурацією Zigbee та визначеннями для цього проекту
#include "modbus.h"                  // Бібліотека для виводу логів у консоль

#include "esp_log.h"                  // Бібліотека для виводу логів у консоль
#include "nvs_flash.h"                // Бібліотека для роботи з енергонезалежною пам'яттю (NVS), де Zigbee зберігає мережеві дані
#include "freertos/FreeRTOS.h"        // Головна бібліотека операційної системи реального часу FreeRTOS
#include "freertos/task.h"            // Бібліотека для роботи з потоками (задачами) у FreeRTOS
#include "esp_zigbee_core.h"          // Основна бібліотека стека Zigbee від Espressif

#include "time.h"
#include "sys/time.h"
#include "timers.h"

void send_boot_status_report(uint8_t status);


static const char *TAG = "Light_Router"; 

// ==========================================
// ОБРОБНИК СИГНАЛІВ ZIGBEE
// ==========================================
void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct) {
    esp_zb_app_signal_type_t sig = (esp_zb_app_signal_type_t)*signal_struct->p_app_signal;
    esp_err_t status = signal_struct->esp_err_status;

    switch (sig) {
        case ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP:
            ESP_LOGI(TAG, "Стек Zigbee запущено, ініціалізація BDB...");
            esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION);
            break;

        case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
        case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
            if (status == ESP_OK) { // Якщо попередня ініціалізація пройшла без помилок
                ESP_LOGI(TAG, "Пристрій готовий. Починаємо пошук мережі (Network Steering)...");
                esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
            } else {
                ESP_LOGE(TAG, "Помилка старту BDB: %d", status);
            }
            break;

        // Сигнал: Процес пошуку мережі (Steering) завершено
        case ESP_ZB_BDB_SIGNAL_STEERING:
            printf("Статус: %d\n", status); // Виводимо статус пошуку мережі (успіх або код помилки)
            if (status == ESP_OK) { // Якщо ми успішно знайшли мережу і приєдналися до неї
                esp_zb_ieee_addr_t ieee; // Змінна для зберігання нашої довгої MAC-адреси
                esp_zb_get_long_address(ieee); // Зчитуємо власну MAC-адресу
                ESP_LOGI(TAG, "✅ Успішно приєднано до мережі! MAC-адреса: %02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x",
                         ieee[7], ieee[6], ieee[5], ieee[4], ieee[3], ieee[2], ieee[1], ieee[0]);
                send_boot_status_report(0);
                timer_init(); // Ініціалізуємо таймер для синхронізації часу з координатором
                
            } else {
                // Якщо мережу не знайдено (координатор вимкнений або закритий для підключення)
                ESP_LOGW(TAG, "❌ Пошук мережі невдалий. Повторна спроба через 5 секунд...");
                vTaskDelay(pdMS_TO_TICKS(5000)); // Засинаємо на 5 секунд (функція FreeRTOS)
                // Знову запускаємо пошук мережі
                esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
            }
            break;
        
        case ESP_ZB_ZDO_SIGNAL_LEAVE:
            ESP_LOGI(TAG, "Пристрій залишив мережу. Статус: %d", status);
            break;

        default:
            ESP_LOGD(TAG, "Отримано Zigbee сигнал: %d, статус: %d", sig, status);
            break;
    }
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message)
{
    esp_err_t ret = ESP_OK;

    if (callback_id == ESP_ZB_CORE_CMD_READ_ATTR_RESP_CB_ID){
        esp_zb_zcl_cmd_read_attr_resp_message_t *resp = (esp_zb_zcl_cmd_read_attr_resp_message_t *)message;
        // Перевірка, чи це кластер часу (0x000A) і чи статус ESP_OK (0x00)
        if (resp->info.cluster == ESP_ZB_ZCL_CLUSTER_ID_TIME) {
            if (resp->info.status != ESP_OK) {
                ESP_LOGE(TAG, "Помилка при отримані часу. Код ZCL: 0x%02X", resp->info.status);
                return ESP_OK;
            }
            esp_zb_zcl_read_attr_resp_variable_t *variable = resp->variables;
            while (variable) {
                if (variable->attribute.id == ESP_ZB_ZCL_ATTR_TIME_TIME_ID) {
                    uint32_t zigbee_time = *(uint32_t *)variable->attribute.data.value;  
                    timer_set_from_Zigbee_to_Unix(zigbee_time); // Виклик функції для встановлення системного часу
                }
                
                variable = variable->next;
            }
        }
    }

    if (callback_id == ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID) {
        esp_zb_zcl_set_attr_value_message_t *attr_msg = (esp_zb_zcl_set_attr_value_message_t *)message;
        
        ESP_LOGI(TAG, "Зміна атрибута на ЕП %d, кластер 0x%x, атрибут ID 0x%x", 
                 attr_msg->info.dst_endpoint, attr_msg->info.cluster, attr_msg->attribute.id);

        // ==========================================
        // ОБРОБКА ЯСКРАВОСТІ (Cluster 0x0008)
        // ==========================================
        if (attr_msg->info.cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL) {
            if (attr_msg->attribute.id == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
                uint8_t level = *(uint8_t *)attr_msg->attribute.data.value;
                led_strip_set_level(attr_msg->info.dst_endpoint, level);
                
                // Використання номера ендпоінту як каналу для Modbus
                int channel = attr_msg->info.dst_endpoint % 10; 
                
                // Запис яскравості у Modbus (для зовнішнього контролю)
                modbus_send_brightness_to_channel(level * 10, channel); 
            }
        }
            // ==========================================
        // ОБРОБКА СИСТЕМНИХ МЕТАДАНИХ (Кастомний кластер 0xFF01 на ЕП 2)
        // ==========================================
        else if (attr_msg->info.cluster == 0xFF01 && attr_msg->info.dst_endpoint == 2) {
            switch (attr_msg->attribute.id) {

                case 0x0000: { // Бут статус
                    uint8_t new_boot_status = *(uint8_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Бут статус змінено на: %d", new_boot_status);
                    // TODO: значення записується у NVS пам'ять
                    break;
                }

                case 0x0001: { // Режим роботи
                    uint8_t new_mode = *(uint8_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Режим роботи встановлено: %d", new_mode);
                    // TODO: значення записується у NVS пам'ять
                    break;
                }

                case 0x0002: { // Поточний час доби (хвилини від півночі, 0-1439)
                    uint16_t new_time = *(uint16_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Поточний час пристрою оновлено: %d хв", new_time);
                    break;
                }

                default:
                    ESP_LOGW(TAG, "Отримано невідомий атрибут системного кластера: 0x%x", attr_msg->attribute.id);
                    break;
            }
        }
        // ==========================================
        // ОБРОБКА ПАРАМЕТРІВ КАНАЛУ (Кастомний кластер 0xFC01 на ЕП 11-13)
        // ==========================================
        else if (attr_msg->info.cluster == 0xFC01 && attr_msg->info.dst_endpoint > 2) {
            // Індекс каналу (0-based) обчислюється з номера ендпоінту,
            // оскільки кожен канал має власний екземпляр кластера 0xFC01
            int channel_index = attr_msg->info.dst_endpoint - SHIFT - 1;

            switch (attr_msg->attribute.id) {

                case 0x0000: { // Офлайн-яскравість каналу
                    uint8_t new_offline_bright = *(uint8_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Канал %d: встановлено офлайн-яскравість %d%%",
                             channel_index + 1, new_offline_bright);
                    // TODO: значення записується у NVS для відповідного каналу
                    break;
                }

                case 0x0001: { // Розклад каналу (Octet String)
                    uint8_t *payload = (uint8_t *)attr_msg->attribute.data.value;
                    uint8_t payload_length = payload[0];
                    printf("Канал %d: Сирий розклад: ", channel_index + 1);
                    for (int i = 0; i < payload_length; i++) {
                        printf("%d ", payload[1 + i]);
                    }
                    printf("\n");
                    /*
                     * Довжина обмежується фактичним розміром отриманого буфера,
                     * щоб пошкоджений або укорочений пакет не спричиняв
                     * читання за межами виділеної пам'яті.
                     */
                    uint8_t available = (uint8_t)(attr_msg->attribute.data.size - 1);
                    if (payload_length > available) {
                        payload_length = available;
                    }

                    time_mark_t *schedule = (time_mark_t *)&payload[1];
                    uint8_t marks_count = payload_length / sizeof(time_mark_t);
                    
                    ESP_LOGI(TAG, "Канал %d: отримано розклад, %d міток",
                             channel_index + 1, marks_count);

                    for (int m = 0; m < marks_count; m++) {
                        ESP_LOGI(TAG, "  Мітка %d -> хвилина: %d, яскравість: %d%%",
                                 m, schedule[m].minute, schedule[m].brightness);
                    }
                    // TODO: значення записується у NVS для відповідного каналу
                    break;
                }

                default:
                    ESP_LOGW(TAG, "Отримано невідомий атрибут для кластера метаданих: 0x%x", attr_msg->attribute.id);
                    break;
            }
        }
    } else {
        ESP_LOGD(TAG, "Receive Zigbee action(0x%x) callback", callback_id);
    }
    return ret;
}

// ==========================================
// ГОЛОВНА ЗАДАЧА ZIGBEE (ПОТІК)
// ==========================================

static void zigbee_task(void *arg) {
    // 1. Конфігурація мережевої ролі пристрою (Роутер)
    esp_zb_cfg_t zb_nwk_cfg = {
        .esp_zb_role = ESP_ZB_DEVICE_TYPE_ROUTER,
        .install_code_policy = false,
        .nwk_cfg.zczr_cfg = { 0 },
    };
    esp_zb_init(&zb_nwk_cfg);
    esp_zb_set_primary_network_channel_set(ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK);

    // Створюю загальний список ендпоінтів
    esp_zb_ep_list_t *endpoint_list = esp_zb_ep_list_create();

    create_greenhouse_light_endpoint_list(endpoint_list); // Функція для заповнення списку ендпоінтів (створена в endpoint_config.c)

    esp_zb_device_register(endpoint_list); 
    // Встановлюємо максимальну кількість дітей
    uint8_t max_children = esp_zb_nwk_get_max_children();
    printf("\nМакс. кількість дітей, дозволена для цього пристрою: %d\n", max_children);
    esp_err_t err = esp_zb_nwk_set_max_children(MAX_CHILDREN); 
    printf("Статус помилки при встановленні нової кількості дітей: %d\n", err);
    max_children = esp_zb_nwk_get_max_children();
    printf("Макс. кількість дітей після встановлення: %d\n", max_children);

    esp_zb_core_action_handler_register(zb_action_handler);

    ESP_LOGI(TAG, "Запуск стека Zigbee");
    esp_zb_start(false);

    while (1) {
        esp_zb_stack_main_loop_iteration();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// Функція обов'язково має приймати (uint8_t param) для сумісності з будильником!
void send_boot_status_report(uint8_t status_value) {
    status_value = 0;
    esp_zb_lock_acquire(portMAX_DELAY);

    esp_err_t err = esp_zb_zcl_set_attribute_val(
        2,                                // Ендпоінт
        0xFF01,                           // Кластер
        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,   // Роль
        0x0000,                           // ID атрибута (boot_status)
        &status_value,                    // Значення
        false                             // Не викликати локальний колбек
    );

    if (err != ESP_OK) {
        ESP_LOGE("BOOT_SYNC", "Помилка запису в локальний атрибут: %s", esp_err_to_name(err));
        esp_zb_lock_release();
        return;
    }

    esp_zb_zcl_report_attr_cmd_t report_cmd = {
        .zcl_basic_cmd = {
            .dst_addr_u.addr_short = 0x0000, // Адреса координатора
            .dst_endpoint = 1,               // Ендпоінт координатора
            .src_endpoint = 2,               // Наш ендпоінт
        },
        .address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT,
        .clusterID = 0xFF01,
        .attributeID = 0x0000,               // ID атрибута має збігатися з тим, що писали вище!
        
        .direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_CLI,
        .dis_default_resp = 0,
        
        .manuf_specific = 0,
        .manuf_code = ESP_ZB_ZCL_ATTR_NON_MANUFACTURER_SPECIFIC
    };
    
    err = esp_zb_zcl_report_attr_cmd_req(&report_cmd);
    esp_zb_lock_release();

    if (err == ESP_OK) {
        ESP_LOGI("BOOT_SYNC","boot_status відправлено" " (boot_status = %d)", status_value);
    } else {
        ESP_LOGE("BOOT_SYNC", "Помилка відправки радіопакета: %s", esp_err_to_name(err));
    }
}
// ==========================================
// ТОЧКА ВХОДУ В ПРОГРАМУ (MAIN)
// ==========================================
void app_main(void) {
    // Ініціалізація енергонезалежної пам'яті (NVS).
    esp_err_t ret = nvs_flash_init();
    
    // Якщо пам'ять пошкоджена, заповнена або має стару структуру
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase()); // Повністю стираємо її
        ESP_ERROR_CHECK(nvs_flash_init());  // І ініціалізуємо заново
    }

    dip_switch_init(); // Ініціалізуємо GPIO для Діп свіча
    light_driver_init(); // Ініціалізуємо драйвер світла
    init_reset_configuration(); // Ініціалізуємо конфігурацію кнопки скидання
    modbus_init();

    ESP_LOGI(TAG, "\nКонфігурація DIP Switch: 0x%02X\n", dip_switch_get_value());
    // Створюємо і запускаємо задачу (потік) для Zigbee у FreeRTOS
    // "zigbee_task" - назва, 4096 - розмір пам'яті для задачі (стек), 5 - пріоритет (досить високий)
    xTaskCreate(zigbee_task, "zigbee_task", 4096, NULL, 5, NULL);
    
    

}