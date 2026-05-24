FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

# デフォルトは何もしない。docker compose run でコマンド指定して実行
CMD ["python", "-c", "print('Specify command: python -m src.fetch_listed or src.fetch_prices')"]
