idf_component_register(SRCS "light_driver.c"
                    INCLUDE_DIRS "include"
                    REQUIRES project_config
                    PRIV_REQUIRES modbus greenhouse_light_control light_driver PWM_control
                    )
