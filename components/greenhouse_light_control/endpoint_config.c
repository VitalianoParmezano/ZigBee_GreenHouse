#include "endpoint_config.h"
#include "dip_switch.h"

#define ESP_MANUFACTURER_NAME "\x03""ESV" 
#define ESP_MODEL_ID          "\x18""Greenhouse_Controller_v1" // \x18 це 24 в HEX

static void format_dip_to_pascal_string(uint8_t dip_val, uint8_t *out_buffer);


#define SHIFT 1 // Зсув для номерів ендпоінтів каналів (щоб не перетинатися з базовим ендпоінтом)


static const char *TAG = "ENDPOINT_CONFIG"; 
// Зсув номерів ендпоінтів каналів

void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list)
{
    //  Готуємо дані (Pascal strings - перший байт довжина)
    uint8_t model_id[] = {24, 'G', 'r', 'e', 'e', 'n', 'h', 'o', 'u', 's', 'e', '_', 'C', 'o', 'n', 't', 'r', 'o', 'l', 'l', 'e', 'r', '_', 'v', '1'};
    uint8_t manufacturer_name[] = {3, 'E', 'S', 'V'};
    uint8_t hw_version = 1;

    dip_switch_init();
    uint8_t dip_val = dip_switch_get_value();
    printf("\nDIP switch value: %u\n", dip_val); 

    // Створюємо буфер для нашого лейбла (4 байти)
    uint8_t basic_product_label[4] = {0}; 

    // ВИКЛИКАЄМО ФУНКЦІЮ: передаємо значення і масив для заповнення
    format_dip_to_pascal_string(dip_val, basic_product_label);

    //  Конфіг для базових параметрів (ZCL version, Power Source)
    esp_zb_basic_cluster_cfg_t basic_cfg = {
        .zcl_version = 0x03,
        .power_source = 0x01,
    };

    //  Створюємо список атрибутів на базі конфігу 
    // (Це автоматично додасть ZCL Version та Power Source)
    esp_zb_attribute_list_t *basic_attr_list = esp_zb_basic_cluster_create(&basic_cfg);

    //  Додаю кастомні атрибути до списку бащового кластеру
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
    
    // Конфіги для кластерів у циклі
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

    for (int i = 1; i <= NUMBER_OF_CHANNEL_ENDPOINTS; i++)
    {
        //Створюю НОВИЙ список кластерів для КОЖНОГО ендпоінта всередині циклу
        esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();


        //Додаємо On/Off
        esp_zb_cluster_list_add_on_off_cluster(cluster_list, esp_zb_on_off_cluster_create(&on_off_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        
        //Додаємо Level Control
        esp_zb_cluster_list_add_level_cluster(cluster_list, esp_zb_level_cluster_create(&level_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        // Керування групами:
        esp_zb_cluster_list_add_groups_cluster(cluster_list, esp_zb_groups_cluster_create(&groups_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        // Керування сценами:
        esp_zb_cluster_list_add_scenes_cluster(cluster_list, esp_zb_scenes_cluster_create(&scenes_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);


        //Конфігурація самого Ендпоінта
        esp_zb_endpoint_config_t level_endpoint_config = { 
            .endpoint = i + SHIFT, // Зсув для каналів
            .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID, 
            .app_device_id = ESP_ZB_HA_DIMMABLE_LIGHT_DEVICE_ID, 
            .app_device_version = 1
        };

        // Додаємо до глобального списку
        esp_zb_ep_list_add_ep(ep_list, cluster_list, level_endpoint_config);
    }

    ESP_LOGI(TAG, "\n=== Детальна інформація про Ендпоінти пристрою ===");
    
    esp_zb_ep_list_t *temp = ep_list;
    int counter = 1;

    // Класичний і чистий цикл перебору зв'язного списку
    while (temp != NULL) {
        esp_zb_endpoint_t *ep = &temp->endpoint; 
        
        printf("----------------------------------------\n");
        printf("[%d] Endpoint ID:     %d\n", counter++, ep->ep_id);
        
        // Profile ID зазвичай виводять у HEX (наприклад, 0x0104 - це Home Automation)
        printf("    Profile ID:      0x%04X\n", ep->profile_id);
        

        // Переходимо до наступного вузла у списку
        temp = temp->next;
    }
    printf("----------------------------------------\n");
    printf("Усього ендпоінтів: %d\n", counter - 1);
    
}

void assign_internal_groups_after_join(void){
    uint8_t dip_val = dip_switch_get_value();
    uint16_t short_addr = esp_zb_get_short_address();

    for (int i = 1; i <= NUMBER_OF_CHANNEL_ENDPOINTS; i++)
    {
        uint8_t target_ep = i + SHIFT;
	// Ця формула визначає ІД групи ендпоінта
        uint16_t target_group_id = dip_val * 10 + i + SHIFT; // 12 - 1 зона, 2 канал

        // Повністю розписана структура без трикрапок
        esp_zb_zcl_groups_add_group_cmd_t add_group_cmd = {
            .zcl_basic_cmd = {
                .dst_addr_u = {
                    .addr_short = short_addr // Використовуємо нашу змінну!
                },
                .dst_endpoint = target_ep,
                .src_endpoint = 1, // Ендпоінт, від імені якого надсилається команда
            },
            .address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT,
            .group_id = target_group_id,
        };

        esp_zb_lock_acquire(portMAX_DELAY);
        // Надсилаємо команду
        esp_zb_zcl_groups_add_group_cmd_req(&add_group_cmd);
        esp_zb_lock_release();

        ESP_LOGI(TAG, "Команду Add Group (%d) надіслано на Endpoint %d", target_group_id, target_ep);
    }
}

// Функція-хелпер: перетворює uint8_t у Zigbee Pascal-рядок
static void format_dip_to_pascal_string(uint8_t dip_val, uint8_t *out_buffer) 
{
    // Записуємо цифри у масив, починаючи з індексу [1]
    // snprintf автоматично повертає кількість записаних символів
    int text_len = snprintf((char *)&out_buffer[1], 4, "%u", dip_val);
    
    // Записуємо довжину тексту в нульовий байт
    out_buffer[0] = (uint8_t)text_len;
}