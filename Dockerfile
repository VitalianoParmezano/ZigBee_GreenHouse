FROM python:3.11-slim

# Налаштування Python
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Безпека
RUN adduser --disabled-password --gecos "" appuser
WORKDIR /app

# Залежності
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Код
COPY . .
RUN chown -R appuser:appuser /app
USER appuser

# Запуск
CMD ["python", "main.py"]
