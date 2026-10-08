# Собственный OCR-сервис Nexus

Сервис распознаёт PDF, JPEG и PNG внутри инфраструктуры ARSEO и реализует HTTP-контракт,
который уже поддерживает Nexus. Временные изображения существуют только в памяти процесса;
исходные документы и распознанный текст сервис на диск и в журналы не записывает.

## Движок

- Tesseract OCR;
- языки: русский (`rus`), казахский (`kaz`) и английский (`eng`);
- PDF рендерится встроенным PDFium;
- не больше 4 МБ, 5 страниц и 40 млн пикселей на страницу по умолчанию.

## Сборка и запуск

Создайте случайный токен длиной не меньше 32 символов и передайте его контейнеру только через
секреты среды выполнения. Не добавляйте токен в GitHub или Docker image.

```bash
docker build -t nexus-ocr:1 services/ocr
docker run --rm -p 127.0.0.1:8080:8080 \
  -e OCR_SERVICE_TOKEN='<случайный-секретный-токен>' \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  nexus-ocr:1
```

Проверка процесса:

```bash
curl http://127.0.0.1:8080/health
```

Сам контейнер слушает HTTP только во внутренней сети. Перед ним нужен reverse proxy компании
(Caddy, nginx или корпоративный ingress) с действующим TLS-сертификатом. В интернет следует
публиковать только HTTPS endpoint, например `https://ocr.example.kz/v1/recognize`; порт 8080
должен оставаться закрытым извне.

## Подключение Nexus

После развёртывания добавьте в серверные secrets Nexus:

```env
OCR_PROVIDER=http
OCR_ACKNOWLEDGE_DATA_TRANSFER=true
OCR_HTTP_ENDPOINT=https://ocr.example.kz/v1/recognize
OCR_HTTP_TOKEN=<тот же секретный токен>
```

Затем перезапустите или заново разверните Nexus. Значения нельзя помещать в `.env.example`,
репозиторий, клиентский JavaScript или логи. До установки всех четырёх переменных OCR остаётся
выключенным.

## Бесплатный пилот в Google Cloud Run

Cloud Run запускает контейнер только по запросу и при небольшом объёме укладывается в ежемесячную
бесплатную квоту. Для пилота используется регион `europe-west1`, 1 vCPU, 2 ГБ памяти, один запрос
одновременно, не больше одного экземпляра и ноль постоянно работающих экземпляров. Это исключает
постоянную плату за вычисления простаивающего процесса, но первый запрос после паузы будет
выполняться дольше. Бесплатная квота не является жёстким лимитом расходов: сборка, хранение образа,
сетевой трафик или использование сверх квоты могут тарифицироваться. Бюджет Google Cloud отправляет
предупреждения, но сам по себе не останавливает сервис.

Для Cloud Run требуется подключённый billing account, даже когда фактическое использование остаётся
в бесплатной квоте. Создайте бюджет и уведомления в Google Cloud Billing до развёртывания.

В Cloud Shell:

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

openssl rand -hex 32 | gcloud secrets create nexus-ocr-token \
  --replication-policy=automatic --data-file=-

PROJECT_NUMBER="$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding nexus-ocr-token \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

git clone https://github.com/rafiyusha5-commits/NEXUS-ARSEO.git
cd NEXUS-ARSEO/services/ocr

gcloud run deploy nexus-ocr \
  --source . \
  --region europe-west1 \
  --execution-environment gen2 \
  --cpu 1 \
  --memory 2Gi \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 1 \
  --timeout 120 \
  --set-secrets OCR_SERVICE_TOKEN=nexus-ocr-token:latest \
  --allow-unauthenticated
```

`--allow-unauthenticated` делает HTTPS endpoint доступным для сервера Nexus, но каждый запрос к
`/v1/recognize` всё равно требует отдельный длинный Bearer-токен. `/health` не принимает документы
и возвращает только состояние и версию сервиса.

После развёртывания сохраните URL сервиса и добавьте к нему `/v1/recognize` в `OCR_HTTP_ENDPOINT`.
Токен из Secret Manager нужно отдельно установить как `OCR_HTTP_TOKEN` в secrets Nexus; выводить
его в интерфейсе и журналах нельзя.

## Проверка перед production

1. Убедиться, что `/health` отвечает `{"status":"ok"}` только через корпоративный HTTPS-адрес.
2. Проверить, что прямой порт контейнера недоступен извне.
3. Отправить обезличенный тестовый JPG, PDF и PNG.
4. Проверить русский, казахский и английский текст.
5. Убедиться, что Nexus показывает результат как черновик и требует подтверждения сотрудника.
6. Проверить журналы контейнера: в них не должно быть содержимого документов или токена.

## Обновление и откат

Обновление выполняется заменой контейнера на новую версию. Для мгновенного отключения удалите
`OCR_ACKNOWLEDGE_DATA_TRANSFER` или установите `OCR_PROVIDER=disabled` в Nexus и перезапустите
приложение. Уже подтверждённые данные в Nexus сохранятся; новые файлы перестанут отправляться.

## Тесты и защита запросов

Токен проверяется **до** чтения тела запроса, а тело ограничивается при потоковом чтении (`RequestGuard` в `app/main.py`): запрос без токена получает 401, не загрузив ни байта, слишком большой запрос получает 413, даже если у него нет заголовка `Content-Length`.

Тесты запускаются в образе сервиса (в нём есть Tesseract):

```bash
docker build -t nexus-ocr:local services/ocr
docker run --rm --user root -v "$PWD/services/ocr:/app" nexus-ocr:local   sh -c "apt-get update -qq && apt-get install -y -qq fonts-dejavu-core && pip install -q -r requirements-dev.txt && python -m pytest -q"
```

`tests/make_fixtures.py` создаёт синтетические документы для проверок в `tests/fixtures/ocr` репозитория (в контейнере с шрифтами DejaVu, выходная папка `/out`).
