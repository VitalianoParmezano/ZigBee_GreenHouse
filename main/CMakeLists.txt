idf_component_register(
    SRCS 
        "esp_zb_switch.c" 
       
    INCLUDE_DIRS "."
    PRIV_REQUIRES nvs_flash esp_driver_gpio esp_driver_uart ieee802154 esp-zigbee-lib greenhouse_light_control reset_configuration modbus timers state_machine nvs_storage
)