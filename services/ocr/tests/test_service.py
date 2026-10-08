"""Tests of the OCR service: authentication before the body, request limits, file checks and real recognition.

Run inside the service image (it has Tesseract):
    docker run --rm --user root -v "<repo>/services/ocr:/app" nexus-ocr:local \
        sh -c "pip install -q -r requirements-dev.txt && pytest -q"
"""
import base64
import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

TOKEN = "t" * 40
os.environ["OCR_SERVICE_TOKEN"] = TOKEN

from app import main  # noqa: E402  (the token must be set first)

client = TestClient(main.app)
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def encoded(data: bytes) -> str:
    return base64.b64encode(data).decode()


def png(width=800, height=300, text=None) -> bytes:
    image = Image.new("RGB", (width, height), "white")
    if text:
        draw = ImageDraw.Draw(image)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 56)
        except OSError:
            font = ImageFont.load_default(size=56)
        draw.text((40, 100), text, font=font, fill="black")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def payload(data: bytes, mime="image/png", **extra):
    return {"mime_type": mime, "content_base64": encoded(data), **extra}


def test_health_is_open_and_says_nothing_sensitive():
    response = client.get("/health")
    assert response.status_code == 200
    assert set(response.json()) == {"status", "version"}


def test_authentication_is_checked_before_the_body_is_read():
    # an invalid body must not be validated (and not leak the schema) for a caller without a token
    assert client.post("/v1/recognize", json={"nonsense": True}).status_code == 401
    assert client.post("/v1/recognize", json={"nonsense": True}, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/v1/recognize", content=b"not json at all").status_code == 401


def test_service_without_a_configured_token_refuses_everything(monkeypatch):
    monkeypatch.setenv("OCR_SERVICE_TOKEN", "short")
    assert client.post("/v1/recognize", json=payload(png()), headers={"Authorization": "Bearer short"}).status_code == 503


def test_declared_oversized_request_is_refused_only_for_authenticated_callers():
    big = b"x" * (main.MAX_REQUEST_BYTES + 10)
    assert client.post("/v1/recognize", content=big, headers=AUTH).status_code == 413
    assert client.post("/v1/recognize", content=big).status_code == 401


def test_a_chunked_body_without_content_length_is_capped_while_it_is_read():
    def chunks():
        for _ in range(8):
            yield b"x" * (1024 * 1024)

    response = client.post("/v1/recognize", content=chunks(), headers=AUTH)
    assert response.status_code == 413


def test_chunked_body_from_an_unauthenticated_caller_is_not_consumed_for_validation():
    def chunks():
        for _ in range(8):
            yield b"x" * (1024 * 1024)

    assert client.post("/v1/recognize", content=chunks()).status_code == 401


def test_unknown_fields_wrong_signature_and_bad_base64_are_rejected():
    assert client.post("/v1/recognize", json={**payload(png()), "evil": 1}, headers=AUTH).status_code == 422
    assert client.post("/v1/recognize", json=payload(b"\xff\xd8\xff" + b"0" * 50), headers=AUTH).status_code == 422
    assert client.post("/v1/recognize", json={"mime_type": "image/png", "content_base64": "@@@@"}, headers=AUTH).status_code == 422
    assert client.post("/v1/recognize", json={"mime_type": "text/html", "content_base64": "AAAA"}, headers=AUTH).status_code == 422


def test_image_with_too_many_pixels_and_garbage_files_are_rejected(monkeypatch):
    monkeypatch.setattr(main, "MAX_PIXELS", 100_000)
    assert client.post("/v1/recognize", json=payload(png(600, 600)), headers=AUTH).status_code == 422
    assert client.post("/v1/recognize", json=payload(b"\x89PNG\r\n\x1a\n" + b"junk" * 20), headers=AUTH).status_code == 422
    assert client.post("/v1/recognize", json=payload(b"%PDF-1.4\n garbage", "application/pdf"), headers=AUTH).status_code == 422


def test_pdf_with_too_many_pages_is_rejected():
    pages = [Image.new("RGB", (200, 200), "white") for _ in range(6)]
    buffer = io.BytesIO()
    pages[0].save(buffer, "PDF", save_all=True, append_images=pages[1:])
    response = client.post("/v1/recognize", json=payload(buffer.getvalue(), "application/pdf", max_pages=5), headers=AUTH)
    assert response.status_code == 422
    assert "pages" in response.json()["detail"]


def test_a_blank_page_has_no_text():
    assert client.post("/v1/recognize", json=payload(png()), headers=AUTH).status_code == 422


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_recognises_cyrillic_and_kazakh_text_in_images(fmt, mime):
    source = Image.open(io.BytesIO(png(1400, 260, "Әбдірахманов Қайрат 754BA04")))
    buffer = io.BytesIO()
    source.save(buffer, fmt)
    response = client.post("/v1/recognize", json=payload(buffer.getvalue(), mime), headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pages"] == 1 and body["words"] and 0 <= body["confidence"] <= 1
    assert "754" in body["text"] and "Қайрат" in body["text"]


def test_recognises_a_scanned_pdf_without_a_text_layer():
    source = Image.open(io.BytesIO(png(1400, 260, "Водитель: Иванов Иван")))
    buffer = io.BytesIO()
    source.save(buffer, "PDF", resolution=150)
    response = client.post("/v1/recognize", json=payload(buffer.getvalue(), "application/pdf"), headers=AUTH)
    assert response.status_code == 200, response.text
    assert "Иванов" in response.json()["text"]
