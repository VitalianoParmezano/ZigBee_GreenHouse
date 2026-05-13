idf_component_register(
    SRCS 
        "esp_zb_switch.c" 
        "console_handler.c" 
        "switch_driver.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES nvs_flash esp_driver_gpio esp_driver_uart ieee802154 esp-zigbee-lib
)