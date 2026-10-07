FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OCR_SERVICE_PORT=8080

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
       tesseract-ocr \
       tesseract-ocr-eng \
       tesseract-ocr-kaz \
       tesseract-ocr-rus \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system ocr \
    && useradd --system --gid ocr --home-dir /nonexistent --shell /usr/sbin/nologin ocr

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app ./app
USER ocr

EXPOSE 8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${OCR_SERVICE_PORT} --no-access-log --workers 1"]
