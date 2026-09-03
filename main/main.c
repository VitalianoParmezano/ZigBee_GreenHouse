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

// Інтервал фізичного читання з датчика (сировий поллінг)
#define LIGHT_SENSOR_UPDATE_INTERVAL_MS   (2 * 1000)  // 2 секунди — як часто реально опитуємо датчик

// Параметри ZCL-звітування (attribute reporting)
#define LIGHT_SENSOR_REPORT_MIN_INTERVAL  10    // сек — мінімальний час між репортами (анти-спам)
#define LIGHT_SENSOR_REPORT_MAX_INTERVAL  300   // сек — "по таймауту": heartbeat навіть без змін
#define LIGHT_SENSOR_REPORT_DELTA         50    // одиниці MeasuredValue — поріг "значної зміни"

static const char *TAG = "MAIN";
/********************* Define functions **************************/

// Конвертація сирих люксів у формат ZCL MeasuredValue: 10000*log10(Lux)+1
static uint16_t lux_to_zigbee_value(uint16_t lux) {
    if (lux == 0) return 0x0000;
    float zcl_value = 10000.0f * log10f((float)lux) + 1.0f;
    if (zcl_value > 65534.0f) return 0xFFFE;
    return (uint16_t)zcl_value;
}

static void bdb_start_top_level_commissioning_cb(uint8_t mode_mask)
{
    ESP_RETURN_ON_FALSE(esp_zb_bdb_start_top_level_commissioning(mode_mask) == ESP_OK, , TAG, "Failed to start Zigbee commissioning");
}

void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)
{
    uint32_t *p_sg_p       = signal_struct->p_app_signal;
    esp_err_t err_status = signal_struct->esp_err_status;
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
                ESP_LOGI(TAG, "Device rebooted");
            }
        } else {
            /* commissioning failed */
            ESP_LOGW(TAG, "Failed to initialize Zigbee stack (status: %s)", esp_err_to_name(err_status));
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
        } else {
            ESP_LOGI(TAG, "Network steering was not successful (status: %s)", esp_err_to_name(err_status));
            esp_zb_scheduler_alarm((esp_zb_callback_t)bdb_start_top_level_commissioning_cb, ESP_ZB_BDB_MODE_NETWORK_STEERING, 1000);
        }
        break;
    default:
        ESP_LOGI(TAG, "ZDO signal: %s (0x%x), status: %s", esp_zb_zdo_signal_to_string(sig_type), sig_type,
                 esp_err_to_name(err_status));
        break;
    }
}

static esp_err_t zb_attribute_handler(const esp_zb_zcl_set_attr_value_message_t *message)
{
    esp_err_t ret = ESP_OK;
    return ret;
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message)
{
    esp_err_t ret = ESP_OK;
    // switch (callback_id) {
    // case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID:
    //     ret = zb_attribute_handler((esp_zb_zcl_set_attr_value_message_t *)message);
    //     break;
    // default:
    //     ESP_LOGW(TAG, "Receive Zigbee action(0x%x) callback", callback_id);
    //     break;
    // }
    return ret;
}

static void esp_zb_task(void *pvParameters)
{
    /* initialize Zigbee stack */
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

    // ---- Налаштування ZCL-звітування (reporting) для MeasuredValue ----
    esp_zb_zcl_reporting_info_t report_cfg = {
        .direction    = ESP_ZB_ZCL_CMD_DIRECTION_TO_SRV,                       // репорт іде ВІД пристрою ДО координатора
        .ep           = HA_ESP_LIGHT_ENDPOINT,                                 // ендпоінт нашого сенсора
        .cluster_id   = ESP_ZB_ZCL_CLUSTER_ID_ILLUMINANCE_MEASUREMENT,         // кластер "виміряна освітленість"
        .cluster_role = ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,                        // ми — сервер кластера (джерело даних)
        .attr_id      = ESP_ZB_ZCL_ATTR_ILLUMINANCE_MEASUREMENT_MEASURED_VALUE_ID, // атрибут, який репортимо
        .manuf_code   = ESP_ZB_ZCL_ATTR_NON_MANUFACTURER_SPECIFIC,             // не виробничо-специфічний атрибут
        .u.send_info.min_interval     = LIGHT_SENSOR_REPORT_MIN_INTERVAL,      // (б) не частіше N сек навіть при бурхливих змінах
        .u.send_info.max_interval     = LIGHT_SENSOR_REPORT_MAX_INTERVAL,      // (а) heartbeat: репорт кожні N сек навіть без змін
        .u.send_info.def_min_interval = LIGHT_SENSOR_REPORT_MIN_INTERVAL,      // дефолтне значення min (на випадок reset to default)
        .u.send_info.def_max_interval = LIGHT_SENSOR_REPORT_MAX_INTERVAL,      // дефолтне значення max
        .u.send_info.delta.u16        = LIGHT_SENSOR_REPORT_DELTA,             // (б) поріг значної зміни, що тригерить негайний репорт
    };
    esp_zb_zcl_update_reporting_info(&report_cfg);
    // (в) "По запиту" окремого коду не потребує — Read Attributes стек обробляє сам,
    //     віддаючи поточне значення з таблиці атрибутів (те, що ми пишемо нижче через set_attribute_val).

    ESP_ERROR_CHECK(esp_zb_start(false));
    esp_zb_stack_main_loop();
}

static void light_sensor_update_task(void *pvParameters)
{
    for (;;) {
        uint16_t lux = light_sensor_get_value();               // реальне читання з датчика (раз на 30с)
        uint16_t real_lux_value = lux / 1.2f;
        uint16_t zigbee_value = lux_to_zigbee_value(real_lux_value);       // конвертація в формат ZCL

        ESP_LOGI(TAG, "Lux value: %d, Zigbee MeasuredValue: %d", lux, zigbee_value);

        esp_zb_lock_acquire(portMAX_DELAY);
        esp_zb_zcl_set_attribute_val(HA_ESP_LIGHT_ENDPOINT,                                    // ендпоінт
                                      ESP_ZB_ZCL_CLUSTER_ID_ILLUMINANCE_MEASUREMENT,            // кластер
                                      ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,                           // роль (сервер)
                                      ESP_ZB_ZCL_ATTR_ILLUMINANCE_MEASUREMENT_MEASURED_VALUE_ID,// id атрибута
                                      &real_lux_value,                                            // нове значення
                                      false);                                                   // check_access — не перевіряти права запису
        esp_zb_lock_release();

        // Тут стек сам вирішить, слати репорт зараз (delta перевищено) чи чекати max_interval
        vTaskDelay(pdMS_TO_TICKS(LIGHT_SENSOR_UPDATE_INTERVAL_MS));
    }
}

void app_main(void)
{
    light_sensor_init();
    light_sensor_power_on();

    esp_zb_platform_config_t config = {
        .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
    };
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_zb_platform_config(&config));
    xTaskCreate(esp_zb_task, "Zigbee_main", 4096, NULL, 5, NULL);
    xTaskCreate(light_sensor_update_task, "light_upd", 2048, NULL, 4, NULL);
}