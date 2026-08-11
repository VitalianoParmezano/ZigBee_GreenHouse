idf_component_register(SRCS "heart_beat.c"
                    INCLUDE_DIRS "include"
                    PRIV_REQUIRES log esp-zigbee-lib esp_timer light_driver
                    )
