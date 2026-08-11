idf_component_register(SRCS "light_driver.c"
                    INCLUDE_DIRS "include"
                    PRIV_REQUIRES modbus greenhouse_light_control light_driver
                    )
