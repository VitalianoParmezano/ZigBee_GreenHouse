#include "endpoint_config.h"

static const char *TAG = "ENDPOINT_CONFIG"; 
// Зсув номерів ендпоінтів каналів
#define SHIFT 1

void create_greenhouse_light_endpoint_list(esp_zb_ep_list_t *ep_list)
{
    esp_zb_level_cluster_cfg_t level_cluster_cfg = { .current_level = 0x0 }; 
    esp_zb_on_off_cluster_cfg_t on_off_cluster_cfg = { .on_off = false };
    // Базова конфігурація для Basic Cluster, яка буде єдиною на 0 ендпоінті
    esp_zb_basic_cluster_cfg_t basic_cfg = {
    .zcl_version = 0x03,
    .power_source = 0x01,
    };

    esp_zb_cluster_list_t *cluster_list_zero = esp_zb_zcl_cluster_list_create();
    
    esp_zb_cluster_list_add_basic_cluster(cluster_list_zero, esp_zb_basic_cluster_create(&basic_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_ep_list_add_ep(ep_list, cluster_list_zero, (esp_zb_endpoint_config_t){
        .endpoint = 1, // Ендпоінт 1 для Basic Cluster
        .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
        .app_device_id = ESP_ZB_HA_ON_OFF_SWITCH_DEVICE_ID,
        .app_device_version = 1
    });



    

    for (int i = 1; i <= NUMBER_OF_CHANNEL_ENDPOINTS; i++)
    {
        //Створюю НОВИЙ список кластерів для КОЖНОГО ендпоінта всередині циклу
        esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();


        //Додаємо On/Off
        esp_zb_cluster_list_add_on_off_cluster(cluster_list, esp_zb_on_off_cluster_create(&on_off_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
        
        //Додаємо Level Control
        esp_zb_cluster_list_add_level_cluster(cluster_list, esp_zb_level_cluster_create(&level_cluster_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

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
        
        // Simple Descriptor - це найважливіша частина, там зберігається тип пристрою
        if (ep->simple_desc != NULL) {
            printf("    Device ID:       0x%04X\n", ep->simple_desc->app_device_id);
            printf("    Device Version:  %d\n", ep->simple_desc->app_device_version);
        } else {
            printf("    Simple Desc:     NULL (Не ініціалізовано)\n");
        }

        // Статистика кластерів та репортінгу
        printf("    К-ть кластерів:  %d\n", ep->cluster_count);
        printf("    Слоти репортінгу:%d\n", ep->rep_info_count);
        
        // Перевірка, чи зареєстровані обробники подій (handlers)
        printf("    Device Handler:  %s\n", ep->device_handler ? "Встановлено" : "Немає");
        printf("    Identify Handler:%s\n", ep->identify_handler ? "Встановлено" : "Немає");

        // Переходимо до наступного вузла у списку
        temp = temp->next;
    }
    printf("----------------------------------------\n");
    printf("Усього ендпоінтів: %d\n", counter - 1);
    
}

