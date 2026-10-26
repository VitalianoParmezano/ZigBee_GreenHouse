idf_component_register(SRCS "modbus.c"
                    INCLUDE_DIRS "include"
                    REQUIRES project_config
                    PRIV_REQUIRES esp_driver_gpio
                    )
