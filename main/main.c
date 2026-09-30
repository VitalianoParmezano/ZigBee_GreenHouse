#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_check.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "ha/esp_zigbee_ha_standard.h"
#include "zcl_utility.h"
#include "main.h"
#include "light_sensor.h"
#include <math.h>

#if !defined ZB_ED_ROLE
#error Define ZB_ED_ROLE in idf.py menuconfig to compile light (End Device) source code.
#endif

#define LIGHT_SENSOR_UPDATE_INTERVAL_MS   (5 * 1000)  // Опитування датчика кожні 5 секунд
#define KOEFISIENT                        4           // Коефіцієнт світлопропускання корпусу

static const char *TAG = "MAIN";
static bool s_is_connected = false;                   // Прапорець з'єднання з мережею Zigbee

// Конвертація сирих люксів у формат ZCL MeasuredValue: 10000*log10(Lux)+1
static uint16_t lux_to_zigbee_value(uint16_t lux) {
    if (lux == 0) {
        return 0;
    }
    
    float lux_float = (float)lux / 1.2f;
    if (lux_float < 1.0f) {
        lux_float = 1.0f;
    }
    
    float zcl_value = 10000.0f * log10f(lux_float) + 1.0f;
    if (zcl_value > 65534.0f) {
        return 0xFFFE;
    }
    
    return (uint16_t)zcl_value;
}

static void send_sensor_report(uint16_t status_value) {
    // Не надсилаємо репорт, якщо мережа ще недоступна
    if (!s_is_connected) {
        return;
    }

    esp_zb_lock_acquire(portMAX_DELAY);

    // Записуємо локально в ZCL атрибут
    esp_err_t err = esp_zb_zcl_set_attribute_val(
        HA_ESP_LIGHT_ENDPOINT, 
        ESP_ZB_ZCL_CLUSTER_ID_ILLUMINANCE_MEASUREMENT,
        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, 
        ESP_ZB_ZCL_ATTR_ILLUMINANCE_MEASUREMENT_MEASURED_VALUE_ID, 
        &status_value, 
        false
    );

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка запису в локальний атрибут: %s", esp_err_to_name(err));
        esp_zb_lock_release();
        return;
    }

    // Формуємо радіопакет до координатора
    esp_zb_zcl_report_attr_cmd_t report_cmd = {
        .zcl_basic_cmd = {
            .dst_addr_u.addr_short = 0x0000,
            .dst_endpoint = 1,
            .src_endpoint = HA_ESP_LIGHT_ENDPOINT,
        },
        .address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT,
        .clusterID = ESP_ZB_ZCL_CLUSTER_ID_ILLUMINANCE_MEASUREMENT,
        .attributeID = ESP_ZB_ZCL_ATTR_ILLUMINANCE_MEASUREMENT_MEASURED_VALUE_ID,
        .direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_CLI,
        .dis_default_resp = 0,
        .manuf_specific = 0,
        .manuf_code = ESP_ZB_ZCL_ATTR_NON_MANUFACTURER_SPECIFIC
    };
    
    err = esp_zb_zcl_report_attr_cmd_req(&report_cmd);
    esp_zb_lock_release();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка відправки радіопакета: %s", esp_err_to_name(err));
    }
}

static void bdb_start_top_level_commissioning_cb(uint8_t mode_mask) {
    ESP_RETURN_ON_FALSE(esp_zb_bdb_start_top_level_commissioning(mode_mask) == ESP_OK, , TAG, "Failed to start Zigbee commissioning");
}

void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct) {
    uint32_t *p_sg_p       = signal_struct->p_app_signal;
    esp_err_t err_status   = signal_struct->esp_err_status;
    esp_zb_app_signal_type_t sig_type = *p_sg_p;

    switch (sig_type) {
    case ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP:
        ESP_LOGI(TAG, "Initialize Zigbee stack");
        esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION);
        break;

    case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
        if (err_status == ESP_OK) {
            ESP_LOGI(TAG, "Device started up in %s factory-reset mode", esp_zb_bdb_is_factory_new() ? "" : "non");
            if (esp_zb_bdb_is_factory_new()) {
                ESP_LOGI(TAG, "Start network steering");
                esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
            } else {
                ESP_LOGI(TAG, "Device successfully rejoined network");
                s_is_connected = true;
            }
        } else {
            /* Відновлення зв'язку зі старим координатором не вдалося — починаємо пошук нової мережі */
            ESP_LOGW(TAG, "Failed to rejoin network (status: %s). Starting network steering...", esp_err_to_name(err_status));
            s_is_connected = false;
            esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
        }
        break;

    case ESP_ZB_BDB_SIGNAL_STEERING:
        if (err_status == ESP_OK) {
            esp_zb_ieee_addr_t extended_pan_id;
            esp_zb_get_extended_pan_id(extended_pan_id);
            ESP_LOGI(TAG, "Joined network successfully (Extended PAN ID: %02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x, PAN ID: 0x%04hx, Channel:%d, Short Address: 0x%04hx)",
                     extended_pan_id[7], extended_pan_id[6], extended_pan_id[5], extended_pan_id[4],
                     extended_pan_id[3], extended_pan_id[2], extended_pan_id[1], extended_pan_id[0],
                     esp_zb_get_pan_id(), esp_zb_get_current_channel(), esp_zb_get_short_address());
            s_is_connected = true;
        } else {
            ESP_LOGI(TAG, "Network steering was not successful (status: %s), retrying in 1s...", esp_err_to_name(err_status));
            s_is_connected = false;
            esp_zb_scheduler_alarm((esp_zb_callback_t)bdb_start_top_level_commissioning_cb, ESP_ZB_BDB_MODE_NETWORK_STEERING, 1000);
        }
        break;

    case ESP_ZB_ZDO_DEVICE_UNAVAILABLE: {
        esp_zb_zdo_device_unavailable_params_t *p =
            (esp_zb_zdo_device_unavailable_params_t *)
            esp_zb_app_signal_get_params(signal_struct->p_app_signal);

        ESP_LOGW(TAG, "Device unavailable, IEEE: %02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x",
                p->long_addr[7], p->long_addr[6], p->long_addr[5], p->long_addr[4],
                p->long_addr[3], p->long_addr[2], p->long_addr[1], p->long_addr[0]);
        break;
    }

    default:
        ESP_LOGI(TAG, "ZDO signal: %s (0x%x), status: %s", esp_zb_zdo_signal_to_string(sig_type), sig_type,
                 esp_err_to_name(err_status));
        break;
    }
}

static esp_err_t zb_attribute_handler(const esp_zb_zcl_set_attr_value_message_t *message) {
    return ESP_OK;
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
    return ESP_OK;
}

static void esp_zb_task(void *pvParameters) {
    esp_zb_cfg_t zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
    esp_zb_init(&zb_nwk_cfg);

    esp_zb_light_sensor_cfg_t light_sensor_cfg = ESP_ZB_DEFAULT_LIGHT_SENSOR_CONFIG();
    esp_zb_ep_list_t *esp_zb_light_sensor_ep = esp_zb_light_sensor_ep_create(HA_ESP_LIGHT_ENDPOINT, &light_sensor_cfg);

    zcl_basic_manufacturer_info_t info = {
        .manufacturer_name = ESP_MANUFACTURER_NAME,
        .model_identifier = ESP_MODEL_IDENTIFIER,
    };

    esp_zcl_utility_add_ep_basic_manufacturer_info(esp_zb_light_sensor_ep, HA_ESP_LIGHT_ENDPOINT, &info);
    esp_zb_device_register(esp_zb_light_sensor_ep);
    esp_zb_core_action_handler_register(zb_action_handler);
    esp_zb_set_primary_network_channel_set(ESP_ZB_PRIMARY_CHANNEL_MASK);

    esp_zb_zcl_attr_location_info_t attr_report_info = {
        .endpoint_id  = HA_ESP_LIGHT_ENDPOINT,
        .cluster_id   = ESP_ZB_ZCL_CLUSTER_ID_ILLUMINANCE_MEASUREMENT,
        .cluster_role = ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
        .manuf_code   = ESP_ZB_ZCL_ATTR_NON_MANUFACTURER_SPECIFIC,
        .attr_id      = ESP_ZB_ZCL_ATTR_ILLUMINANCE_MEASUREMENT_MEASURED_VALUE_ID,
    };

    esp_zb_zcl_start_attr_reporting(attr_report_info);

    ESP_ERROR_CHECK(esp_zb_start(false));
    esp_zb_stack_main_loop();
}

static void light_sensor_update_task(void *pvParameters) {
    for (;;) {
        uint16_t lux = light_sensor_get_value();
        lux = lux * KOEFISIENT;
        uint16_t zigbee_value = lux_to_zigbee_value(lux);

        ESP_LOGI(TAG, "Lux value: %d, Zigbee MeasuredValue: %d", lux, zigbee_value);

        send_sensor_report(zigbee_value);

        vTaskDelay(pdMS_TO_TICKS(LIGHT_SENSOR_UPDATE_INTERVAL_MS));
    }
}

void app_main(void) {
    light_sensor_init();
    light_sensor_power_on();

    esp_zb_platform_config_t config = {
        .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
    };
    
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_zb_platform_config(&config));
    
    xTaskCreate(esp_zb_task, "Zigbee_main", 4096, NULL, 5, NULL);
    xTaskCreate(light_sensor_update_task, "light_upd", 4096, NULL, 4, NULL);
}