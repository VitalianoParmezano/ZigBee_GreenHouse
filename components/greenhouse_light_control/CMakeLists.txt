idf_component_register(
    SRCS 
       "endpoint_config.c"
      
    INCLUDE_DIRS 
        "include" 
    PRIV_REQUIRES 
        esp-zigbee-lib
        log            
)