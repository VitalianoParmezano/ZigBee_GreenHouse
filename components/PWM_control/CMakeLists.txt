idf_component_register(SRCS "PWM_control.c"
                    INCLUDE_DIRS "include"
                    REQUIRES project_config
                    PRIV_REQUIRES esp_driver_ledc esp_driver_gpio freertos)
