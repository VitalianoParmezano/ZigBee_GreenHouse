// Налаштування інтервалів (у мікросекундах) для сигналу серцебиття
// Стандартна мінімальна перевірка серцебиття 
#define PING_BASE_INTERVAL_US    50000000ULL // 50 секунд 
// Додаткові випадкові секунди (p.s. створено щоб усі пристрої одночасно не штормили мережу)
#define PING_RANDOM_WINDOW_US    20000000ULL // + до 20 секунд (разом 50-70 сек)
#define WATCHDOG_TIMEOUT_US      180000000ULL // 3 хвилини (180 сек) без відповіді = Офлайн


void heart_beat_input_value(uint8_t value);

void heart_beat_init(void);