idf_component_register(
    SRCS 
        "endpoint_config.c"
        "my_led_strip.c"
       
    INCLUDE_DIRS 
        "include" 
    REQUIRES
        esp-zigbee-lib
    PRIV_REQUIRES 
        log            
        reset_configuration
)