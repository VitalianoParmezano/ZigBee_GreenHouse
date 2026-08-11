idf_component_register(
    SRCS 
        "endpoint_config.c"
        "my_led_strip.c"
       
    INCLUDE_DIRS 
        "include" 
    PRIV_REQUIRES 
        esp-zigbee-lib
        log            
        reset_configuration
)