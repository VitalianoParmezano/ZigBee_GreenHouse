idf_component_register(
    SRCS "reset_configuration.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio button
    PRIV_REQUIRES greenhouse_light_control
    )
