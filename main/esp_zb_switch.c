#include "console_handler.h"
#include "esp_log.h"                  // Бібліотека для виводу логів у консоль
#include "nvs_flash.h"                // Бібліотека для роботи з енергонезалежною пам'яттю (NVS), де Zigbee зберігає мережеві дані
#include "freertos/FreeRTOS.h"        // Головна бібліотека операційної системи реального часу FreeRTOS
#include "freertos/task.h"            // Бібліотека для роботи з потоками (задачами) у FreeRTOS
#include "esp_zigbee_core.h"          // Основна бібліотека стека Zigbee від Espressif

static const char *TAG = "SIMPLE_ROUTER"; // Текстова мітка (тег), яка буде додаватися до кожного лога цього файлу

// ==========================================
// ОБРОБНИК СИГНАЛІВ ZIGBEE
// ==========================================
// Ця функція викликається автоматично стеком Zigbee, коли відбуваються якісь події (сигнали)
void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct) {
    // Отримуємо тип поточного сигналу (наприклад: старт, пошук мережі, помилка)
    esp_zb_app_signal_type_t sig = (esp_zb_app_signal_type_t)*signal_struct->p_app_signal;
    // Отримуємо статус виконання попередньої команди (успіх або код помилки)
    esp_err_t status = signal_struct->esp_err_status;

    // Перевіряємо, який саме сигнал ми отримали
    switch (sig) {
        // Сигнал: Базова ініціалізація стека завершена, час налаштовувати пристрій
        case ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP:
            ESP_LOGI(TAG, "Стек Zigbee запущено, ініціалізація BDB...");
            // Запускаємо режим ініціалізації (Base Device Behavior - базова поведінка пристрою)
            esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION);
            break;

        // Сигнал: Пристрій запускається вперше після прошивки
        case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
        // Сигнал: Пристрій перезавантажився (був вимкнений з розетки і ввімкнений знову)
        case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
            if (status == ESP_OK) { // Якщо попередня ініціалізація пройшла без помилок
                ESP_LOGI(TAG, "Пристрій готовий. Починаємо пошук мережі (Network Steering)...");
                // Роутер не створює мережу, а шукає існуючу, тому запускаємо режим NETWORK_STEERING
                esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
            } else {
                // Якщо ініціалізація провалилася, виводимо код помилки
                ESP_LOGE(TAG, "Помилка старту BDB: %d", status);
            }
            break;

        // Сигнал: Процес пошуку мережі (Steering) завершено
        case ESP_ZB_BDB_SIGNAL_STEERING:
            printf("Статус: %d\n", status); // Виводимо статус пошуку мережі (успіх або код помилки)
            if (status == ESP_OK) { // Якщо ми успішно знайшли мережу і приєдналися до неї
                esp_zb_ieee_addr_t ieee; // Змінна для зберігання нашої довгої MAC-адреси
                esp_zb_get_long_address(ieee); // Зчитуємо власну MAC-адресу
                // Виводимо радісне повідомлення з нашою повною адресою
                ESP_LOGI(TAG, "✅ Успішно приєднано до мережі! MAC-адреса: %02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x",
                         ieee[7], ieee[6], ieee[5], ieee[4], ieee[3], ieee[2], ieee[1], ieee[0]);
                // Далі робити нічого не треба — пристрій автоматично працює як ретранслятор у фоновому режимі
            } else {
                // Якщо мережу не знайдено (координатор вимкнений або закритий для підключення)
                ESP_LOGW(TAG, "❌ Пошук мережі невдалий. Повторна спроба через 5 секунд...");
                vTaskDelay(pdMS_TO_TICKS(5000)); // Засинаємо на 5 секунд (функція FreeRTOS)
                // Знову запускаємо пошук мережі
                esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
            }
            break;

        // Для всіх інших сигналів, які нас не цікавлять
        default:
            // Просто друкуємо їх у лог для дебаггінгу (видно лише в режимі DEBUG)
            ESP_LOGD(TAG, "Отримано Zigbee сигнал: %d, статус: %d", sig, status);
            break;
    }
}

// ==========================================
// ГОЛОВНА ЗАДАЧА ZIGBEE (ПОТІК)
// ==========================================
static void zigbee_task(void *arg) {
    // 1. Конфігурація мережевої ролі пристрою
    esp_zb_cfg_t zb_nwk_cfg = {
        .esp_zb_role = ESP_ZB_DEVICE_TYPE_ROUTER, // Вказуємо, що ми Роутер (ретранслятор)
        .install_code_policy = false,             // Вимикаємо складну політику інсталяційних кодів безпеки
        .nwk_cfg.zczr_cfg = { 0 },                // Обнуляємо інші мережеві параметри (використовуємо стандартні)
    };
    esp_zb_init(&zb_nwk_cfg); // Ініціалізуємо стек Zigbee нашими параметрами

    // Дозволяємо пристрою шукати мережі на всіх стандартних Zigbee каналах (з 11 по 26)
    esp_zb_set_primary_network_channel_set(ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK);

    // 2. Створення базового кластера (Basic Cluster - містить загальну інфу про пристрій)
    esp_zb_basic_cluster_cfg_t basic_cfg = {
        .zcl_version = 0x08, // Використовуємо специфікацію ZCL версії 8
        .power_source = ESP_ZB_ZCL_BASIC_POWER_SOURCE_MAINS_SINGLE_PHASE, // Вказуємо, що ми живимося від мережі 220В (щоб координатор знав, що ми не спимо)
    };
    // Створюємо сам кластер у пам'яті
    esp_zb_attribute_list_t *basic_cluster = esp_zb_basic_cluster_create(&basic_cfg);
    // Записуємо в кластер назву виробника
    esp_zb_basic_cluster_add_attr(basic_cluster, ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, (void *)"MyBrand");
    // Записуємо в кластер назву моделі пристрою
    esp_zb_basic_cluster_add_attr(basic_cluster, ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, (void *)"SimpleRouter_H2");

    // 3. Збірка всього цього в Ендпоінт
    // Створюємо порожній список кластерів для нашого ендпоінта
    esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();
    // Додаємо туди наш створений базовий кластер (у ролі сервера)
    esp_zb_cluster_list_add_basic_cluster(cluster_list, basic_cluster, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    // Налаштовуємо параметри самого ендпоінта
    esp_zb_endpoint_config_t ep_cfg = {
        .endpoint = 1,                                       // Наш ендпоінт буде під номером 1
        .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,           // Використовуємо профіль Home Automation (HA)
        .app_device_id = ESP_ZB_HA_RANGE_EXTENDER_DEVICE_ID, // Вказуємо тип пристрою: 0x0008 (Range Extender / Підсилювач сигналу)
        .app_device_version = 1,                             // Версія прошивки/заліза
    };
    
    // створюю свої ендпоінти
    // ------------------
    // створюю свої ендпоінти
    // ------------------
    

    // Створюємо загальний список ендпоінтів пристрою (у нас він один)
    esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
    // Додаємо наш ендпоінт №1 до списку
    esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg);
    
    // Офіційно реєструємо наш віртуальний пристрій у стеку Zigbee
    esp_zb_device_register(ep_list);

    // 4. Запуск і нескінченний цикл
    ESP_LOGI(TAG, "Запуск стека Zigbee (роутер)...");
    esp_zb_start(false); // Стартуємо Zigbee

    // Нескінченний цикл, який підтримує роботу Zigbee
    while (1) {
        esp_zb_stack_main_loop_iteration(); // Дозволяємо стеку обробити свої внутрішні задачі
        vTaskDelay(pdMS_TO_TICKS(10));      // Віддаємо процесорний час іншим задачам на 10 мілісекунд, щоб не перевантажувати ядро
    }
}

// ==========================================
// ТОЧКА ВХОДУ В ПРОГРАМУ (MAIN)
// ==========================================
void app_main(void) {
    // Ініціалізація енергонезалежної пам'яті (NVS). Це критично важливо, бо Zigbee зберігає тут ключі мережі
    esp_err_t ret = nvs_flash_init();
    
    // Якщо пам'ять пошкоджена, заповнена або має стару структуру
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase()); // Повністю стираємо її
        ESP_ERROR_CHECK(nvs_flash_init());  // І ініціалізуємо заново
    }

    // Створюємо і запускаємо задачу (потік) для Zigbee у FreeRTOS
    // "zigbee_task" - назва, 4096 - розмір пам'яті для задачі (стек), 5 - пріоритет (досить високий)
    xTaskCreate(zigbee_task, "zigbee_task", 4096, NULL, 5, NULL);
}