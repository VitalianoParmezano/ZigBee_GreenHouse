#include "nvs_flash.h"
#include "nvs_storage.h"
#include "esp_log.h"
#include <stdio.h>

static const char *TAG = "NVS_STORAGE";
static const char *NAMESPACE = "storage";

esp_err_t nvs_storage_init(void)
{
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS пошкоджено або застаріле, стираю розділ...");
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "NVS успішно ініціалізовано.");
    } else {
        ESP_LOGE(TAG, "Помилка ініціалізації NVS: %s", esp_err_to_name(err));
    }

    return err;
}

esp_err_t nvs_write_offline_brightness(uint8_t channel, uint8_t value)
{

    uint8_t existing_value = nvs_read_offline_brightness(channel, 0);
    if (existing_value == value) {
        ESP_LOGI(TAG, "Значення offline_brightness для каналу %d вже встановлено на %d, пропускаю запис.", channel, value);
        return ESP_OK;
    }

    char key[16];
    snprintf(key, sizeof(key), "ch%d_offbr", channel);

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалось відкрити NVS для запису '%s': %s", key, esp_err_to_name(err));
        return err;
    }

    err = nvs_set_u8(handle, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка запису '%s' = %d: %s", key, value, esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "Записано '%s' = %d", key, value);
    }

    nvs_close(handle);
    return err;
}

uint8_t nvs_read_offline_brightness(uint8_t channel, uint8_t default_value)
{
    char key[16];
    snprintf(key, sizeof(key), "ch%d_offbr", channel);

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "NVS namespace ще не існує, повертаю дефолт для '%s': %d", key, default_value);
        return default_value;
    }

    uint8_t value = default_value;
    err = nvs_get_u8(handle, key, &value);
    nvs_close(handle);

    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "Ключ '%s' не знайдено, повертаю дефолт: %d", key, default_value);
        return default_value;
    } else if (err != ESP_OK) {
        ESP_LOGE(TAG, "Помилка читання '%s': %s, повертаю дефолт: %d", key, esp_err_to_name(err), default_value);
        return default_value;
    }

    ESP_LOGI(TAG, "Прочитано '%s' = %d", key, value);
    return value;
}