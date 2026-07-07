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
        // ОБРОБКА МЕТАДАНИХ (Кастомний кластер 0xFF01 на ЕП 2)
        // ==========================================
        else if (attr_msg->info.cluster == 0xFF01 && attr_msg->info.dst_endpoint == 2) {
            switch (attr_msg->attribute.id) {
                
                case 0x0000: { // Режим роботи
                    uint8_t new_mode = *(uint8_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Встановлено новий режим роботи: %d", new_mode);
                    // TODO: Запис new_mode у NVS пам'ять
                    break;
                }

                case 0x0002: { // Офлайн-яскравість
                    uint8_t new_offline_bright = *(uint8_t *)attr_msg->attribute.data.value;
                    ESP_LOGI(TAG, "Встановлено офлайн-яскравість: %d%%", new_offline_bright);
                    // TODO: Запис new_offline_bright у NVS пам'ять
                    break;
                }

                case 0x0003: { // Бінарний масив розкладу
                    uint8_t *payload = (uint8_t *)attr_msg->attribute.data.value;
                    
                    // Читання першого байта (довжина корисного навантаження)
                    uint8_t payload_length = payload[0]; 
                    
                    // Накладання структури на сирі дані (зміщення на 1 байт для пропуску довжини)
                    time_mark_t *schedule = (time_mark_t *)&payload[1];
                    
                    ESP_LOGI(TAG, "Отримано новий розклад. Довжина: %d байт", payload_length);
                    ESP_LOGI(TAG, "Перевірка мітки 1 -> Час: %d хв, Яскравість: %d%%", 
                             schedule[0].minute, schedule[0].brightness);
                             
                    // TODO: Запис масиву payload (або schedule) у NVS пам'ять
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