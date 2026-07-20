#include "endpoint_config.h"
#include "dip_switch.h"

#define ESP_MANUFACTURER_NAME "\x03""ESV" 
#define ESP_MODEL_ID          "\x18""Greenhouse_Controller_v1" // \x18 це 24 в HEX

static void format_dip_to_pascal_string(uint8_t dip_val, uint8_t *out_buffer);


// Глобальні змінні для кастомного кластера
static uint8_t boot_status = 0;       // Атрибут 0x0000: Статус завантаження: по-дефолту 0, після отримання даних від сервера змінюється на 1
static uint8_t current_mode = 0;          // Атрибут 0x0001: Поточний режим роботи (0 - Manual, 1 - Auto, 2 - Timer)
static uint8_t offline_brightness = 50;   // Атрибут 0x0002: Значення яскравості у випадку відсутності з'єднання (0-100)
static uint16_t current_time = 0;                 // Атрибут 0x0003: Час у хвилинах (0-1439)
/*
* Атрибут 0x0003: Рядок октетів (Octet String) для бінарного розкладу. Таймерні сценарії.
* * За специфікацією Zigbee ZCL, перший байт масиву типу OCTET_STRING 
* завжди визначає довжину корисного навантаження. Пакет містить 36 байт даних,
* нульовий індекс ініціалізується значенням 36, 
* а решта пам'яті заповнюється нулями.
*   36 томущо часова мітка має 3 байти (time_mark_t), є 12 міток (12 * 3 = 36).
*   Після отримання даних від сервера, перший байт буде замінений на фактичну довжину отриманого масиву, а решта байтів буде заповнена даними. 
*/
static uint8_t timer_data[37] = {36, 0}; 

static const char *TAG = "ENDPOINT_CONFIG"; 

void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list)
{
    //  Готуємо дані (Pascal strings - перший байт довжина)
    uint8_t model_id[] = {24, 'G', 'r', 'e', 'e', 'n', 'h', 'o', 'u', 's', 'e', '_', 'C', 'o', 'n', 't', 'r', 'o', 'l', 'l', 'e', 'r', '_', 'v', '1'};
    uint8_t manufacturer_name[] = {3, 'E', 'S', 'V'};
    uint8_t hw_version = 1;

    dip_switch_init();
    uint8_t dip_val = dip_switch_get_value();
    printf("\nDIP switch value: %u\n", dip_val); 

    // буфер для нашого номера діпсвіча (4 байти)
    uint8_t basic_product_label[4] = {0}; 

    // передаємо значення і масив для заповнення
    format_dip_to_pascal_string(dip_val, basic_product_label);

    //  Конфіг для базових параметрів (ZCL version, Power Source)
    esp_zb_basic_cluster_cfg_t basic_cfg = {
        .zcl_version = 0x03,
        .power_source = 0x01,
    };

    //  Створюємо список атрибутів на базі конфігу 
    // (Це автоматично додасть ZCL Version та Power Source)
    esp_zb_attribute_list_t *basic_attr_list = esp_zb_basic_cluster_create(&basic_cfg);

    //  Додаю кастомні атрибути до списку базового кластеру
    esp_zb_basic_cluster_add_attr(basic_attr_list, ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, model_id);
    esp_zb_basic_cluster_add_attr(basic_attr_list, ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, manufacturer_name);
    esp_zb_basic_cluster_add_attr(basic_attr_list, ESP_ZB_ZCL_ATTR_BASIC_HW_VERSION_ID, &hw_version);
    esp_zb_basic_cluster_add_attr(basic_attr_list, ESP_ZB_ZCL_ATTR_BASIC_PRODUCT_LABEL_ID, basic_product_label);

    // Створюємо список кластерів для ендпоінта
    esp_zb_cluster_list_t *cluster_list_first = esp_zb_zcl_cluster_list_create();

    //  Додаємо наш ПОВНИЙ Basic Cluster (Тільки один раз!)
    esp_zb_cluster_list_add_basic_cluster(cluster_list_first, basic_attr_list, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_ep_list_add_ep(ep_list, cluster_list_first, (esp_zb_endpoint_config_t){
    .endpoint = 1,
    .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,  
    .app_device_id = ESP_ZB_HA_ON_OFF_SWITCH_DEVICE_ID,
    .app_device_version = 1
});

// Конфіг 2 ендпоінта, тут буде запис режиму роботи, статус чи готовий завантажити дані з сервера про поточну яскравість
// і значення яскравості яке буде у випадку відсутності з'єднання. TODO останнє




// Конфіг 2 ендпоінта: запис режиму роботи, статус готовності до завантаження 
    // і значення яскравості, яке буде у випадку відсутності з'єднання.
    esp_zb_endpoint_config_t endpoint_config_2 = {
        .endpoint = 2,
        .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
        .app_device_id = ESP_ZB_HA_CUSTOM_ATTR_DEVICE_ID,
        .app_device_version = 1
    };

    // Ініціалізація списку кластерів для другого ендпоінта
    esp_zb_cluster_list_t *cluster_list_second = esp_zb_zcl_cluster_list_create();

    // Додавання обов'язкових базових кластерів (КРИТИЧНО для розпізнавання в Z2M)
    esp_zb_cluster_list_add_basic_cluster(cluster_list_second, esp_zb_basic_cluster_create(NULL), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
    esp_zb_cluster_list_add_identify_cluster(cluster_list_second, esp_zb_identify_cluster_create(NULL), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    // Ініціалізація кастомного кластера для метаданих
    esp_zb_attribute_list_t *custom_cluster = esp_zb_zcl_attr_list_create(0xFF01); 

    // --- Реєстрація атрибутів у кластері відповідно до оновлених змінних ---

    // Атрибут 0x0000: Статус завантаження
    // Прапорець ESP_ZB_ZCL_ATTR_ACCESS_REPORTING вмикає автоматичне надсилання звіту при зміні.
    esp_zb_custom_cluster_add_custom_attr(
        custom_cluster, 
        0x0000, 
        ESP_ZB_ZCL_ATTR_TYPE_U8, 
        ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING, 
        &boot_status
    );

    // Атрибут 0x0001: Поточний режим роботи (0 - Manual, 1 - Auto, 2 - Timer)
    esp_zb_custom_cluster_add_custom_attr(
        custom_cluster, 
        0x0001, 
        ESP_ZB_ZCL_ATTR_TYPE_U8, 
        ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE, 
        &current_mode
    );
    // Атрибут 0x0002: Значення часу у хвилинах (0-1439)
    esp_zb_custom_cluster_add_custom_attr(
        custom_cluster, 
        0x0002, 
        ESP_ZB_ZCL_ATTR_TYPE_U16, 
        ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE, 
        &current_time
    );

    // Додавання наповненого кастомного кластера до списку кластерів другого ендпоінта
    esp_zb_cluster_list_add_custom_cluster(cluster_list_second, custom_cluster, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    /*
     * Реєстрація другого ендпоінта у загальному списку пристрою.
     */
    esp_zb_ep_list_add_ep(ep_list, cluster_list_second, endpoint_config_2);
    
    
    //------------------------------------------------
    //------------------------------------------------
    //------------------------------------------------
    // Конфіги для кластерів у циклі
    // Застосовуються для усіх ендпоінтів каналів
    esp_zb_level_cluster_cfg_t level_cluster_cfg = { .current_level = 0x0 }; 
    esp_zb_on_off_cluster_cfg_t on_off_cluster_cfg = { .on_off = false };
    esp_zb_groups_cluster_cfg_t groups_cfg = { .groups_name_support_id = 0 }; // Група 
    esp_zb_scenes_cluster_cfg_t scenes_cfg = { // Сцени потрібні для груп (залежність)
        .scenes_count = 16,
        .current_scene = 0,
        .current_group = 0,
        .scene_valid = 0,
        .name_support = 0,
    };

    //Офлайн яскравість для кожного каналу
    static uint8_t channel_offline_brightness[NUMBER_OF_CHANNEL_ENDPOINTS] = {50, 50, 50};

    //Часові мітки для кожного каналу 
    static uint8_t channel_timer_data[NUMBER_OF_CHANNEL_ENDPOINTS][37] = {
        {36, 0},
        {36, 0},
        {36, 0}
    };

    //------------------------------------------------
    // ЦИКЛ СТВОРЮЄ КАНАЛИ (ЕНДПОІНТИ) ДЛЯ КЕРУВАННЯ ЯСКРАВОСТЮ
    //------------------------------------------------
    for (int i = 1; i <= NUMBER_OF_CHANNEL_ENDPOINTS; i++)
    {
        esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();

        esp_zb_cluster_list_add_on_off_cluster(cluster_list, esp_zb_on_off_cluster_create(&on_off_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        esp_zb_cluster_list_add_level_cluster(cluster_list, esp_zb_level_cluster_create(&level_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        esp_zb_cluster_list_add_groups_cluster(cluster_list, esp_zb_groups_cluster_create(&groups_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        esp_zb_cluster_list_add_scenes_cluster(cluster_list, esp_zb_scenes_cluster_create(&scenes_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

        /*
        * Кастомний кластер додається окремо для кожного каналу, тому дані
        * кожного каналу зберігаються і адресуються незалежно одне від одного.
        */
        esp_zb_attribute_list_t *channel_custom_cluster = esp_zb_zcl_attr_list_create(0xFC01);

        // Атрибут 0x0000: яскравість каналу у випадку відсутності з'єднання
        esp_zb_custom_cluster_add_custom_attr(
            channel_custom_cluster,
            0x0000,
            ESP_ZB_ZCL_ATTR_TYPE_U8,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE,
            &channel_offline_brightness[i - 1]
        );

        // Атрибут 0x0001: бінарний масив розкладу (Octet String) для цього каналу
        esp_zb_custom_cluster_add_custom_attr(
            channel_custom_cluster,
            0x0001,
            ESP_ZB_ZCL_ATTR_TYPE_OCTET_STRING,
            ESP_ZB_ZCL_ATTR_ACCESS_READ_WRITE,
            channel_timer_data[i - 1]
        );

        esp_zb_cluster_list_add_custom_cluster(cluster_list, channel_custom_cluster, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

        esp_zb_endpoint_config_t level_endpoint_config = {
            .endpoint = i + SHIFT,
            .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
            .app_device_id = ESP_ZB_HA_DIMMABLE_LIGHT_DEVICE_ID,
            .app_device_version = 1
        };

        esp_zb_ep_list_add_ep(ep_list, cluster_list, level_endpoint_config);
    }
}

// перетворює uint8_t у Zigbee Pascal-рядок
static void format_dip_to_pascal_string(uint8_t dip_val, uint8_t *out_buffer) 
{
    // Запис цифр у масив, починаючи з індексу [1]
    // snprintf автоматично повертає кількість записаних символів
    int text_len = snprintf((char *)&out_buffer[1], 4, "%u", dip_val);
    
    // Запис довжини тексту в нульовий байт
    out_buffer[0] = (uint8_t)text_len;
}