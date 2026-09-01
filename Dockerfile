FROM python:3.12-slim

# tzdata - без нього контейнер живе в UTC, а datetime.now() у
# schedule_logic.py рахує "зараз" за ЛОКАЛЬНИМ часом - без коректного
# часового поясу вся резолюція таймерного розкладу поїде на кілька годин.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.txt копіюємо окремим шаром - pip install кешується Docker'ом,
# поки requirements.txt не змінився, навіть якщо міняється сам код.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Базова копія коду в образ - працює "з коробки" навіть БЕЗ volume
# (наприклад, docker run без -v). У docker-compose.yml цей каталог
# додатково монтується як bind volume поверх /app - тоді живим є код
# з хоста, а це COPY лишається лише фолбеком.
COPY . .

CMD ["python", "main.py"]
