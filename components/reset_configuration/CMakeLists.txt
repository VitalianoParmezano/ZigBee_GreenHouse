idf_component_register(
    SRCS "dip_switch.c" "reset_configuration.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio button
    PRIV_REQUIRES greenhouse_light_control esp-zigbee-lib timers main state_machine
    )
