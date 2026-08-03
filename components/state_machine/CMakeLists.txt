idf_component_register(SRCS "state_machine.c"
                    INCLUDE_DIRS "include"
                    REQUIRES timers
                    PRIV_REQUIRES greenhouse_light_control)
