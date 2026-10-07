from __future__ import annotations

import base64
import binascii
import io
import os
import secrets
from dataclasses import dataclass
from typing import Annotated, Literal

import pypdfium2 as pdfium
import pytesseract
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field
from pytesseract import Output

SERVICE_VERSION = "tesseract-v1"
MAX_FILE_BYTES = int(os.getenv("OCR_SERVICE_MAX_FILE_BYTES", str(4 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("OCR_SERVICE_MAX_PAGES", "5"))
MAX_PIXELS = int(os.getenv("OCR_SERVICE_MAX_PIXELS", "40000000"))
MAX_REQUEST_BYTES = 6 * 1024 * 1024
DEFAULT_LANGUAGES = "rus+kaz+eng"
ALLOWED_MIME_TYPES = {"application/pdf", "image/jpeg", "image/png"}


class RecognizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mime_type: Literal["application/pdf", "image/jpeg", "image/png"]
    content_base64: str = Field(min_length=4, max_length=5_700_000)
    max_pages: int = Field(default=5, ge=1, le=10)
    language_hints: list[str] = Field(default_factory=list, max_length=10)


class OcrWord(BaseModel):
    text: str
    confidence: float = Field(ge=0, le=1)


class RecognizeResponse(BaseModel):
    text: str
    pages: int
    confidence: float | None
    words: list[OcrWord]
    engine_version: str


@dataclass(frozen=True)
class PageResult:
    text: str
    words: list[OcrWord]


app = FastAPI(
    title="Nexus OCR",
    version=SERVICE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def reject_oversized_requests(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, content={"detail": "request too large"})
        except ValueError:
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": "invalid content length"})
    return await call_next(request)


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    configured = os.getenv("OCR_SERVICE_TOKEN", "")
    if len(configured) < 32:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="service is not configured")
    supplied = authorization.removeprefix("Bearer ") if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, configured):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


def decode_document(value: str) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid base64") from exc
    if not data or len(data) > MAX_FILE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="file too large")
    return data


def validate_signature(data: bytes, mime_type: str) -> None:
    valid = (
        mime_type == "application/pdf" and data.startswith(b"%PDF-")
        or mime_type == "image/jpeg" and data.startswith(b"\xff\xd8\xff")
        or mime_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")
    )
    if not valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="file signature does not match mime type")


def normalize_image(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if image.width * image.height > MAX_PIXELS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="image has too many pixels")
    if image.mode not in {"L", "RGB"}:
        image = image.convert("RGB")
    return image


def render_pages(data: bytes, mime_type: str, requested_max_pages: int) -> list[Image.Image]:
    limit = min(requested_max_pages, MAX_PAGES)
    if mime_type != "application/pdf":
        try:
            with Image.open(io.BytesIO(data)) as source:
                source.load()
                return [normalize_image(source.copy())]
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid image") from exc

    try:
        document = pdfium.PdfDocument(data)
        page_count = len(document)
        if page_count == 0:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="empty pdf")
        if page_count > limit:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="pdf has too many pages")
        pages: list[Image.Image] = []
        for index in range(page_count):
            page = document[index]
            # 200 DPI provides a useful compromise for photographed and printed logistics documents.
            scale = 200 / 72
            width, height = page.get_size()
            if int(width * scale) * int(height * scale) > MAX_PIXELS:
                page.close()
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="pdf page has too many pixels")
            bitmap = page.render(scale=scale)
            pages.append(normalize_image(bitmap.to_pil()))
            page.close()
        document.close()
        return pages
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid or encrypted pdf") from exc


def recognize_page(image: Image.Image) -> PageResult:
    config = "--oem 1 --psm 3"
    text = pytesseract.image_to_string(image, lang=DEFAULT_LANGUAGES, config=config).strip()
    data = pytesseract.image_to_data(image, lang=DEFAULT_LANGUAGES, config=config, output_type=Output.DICT)
    words: list[OcrWord] = []
    for raw_text, raw_confidence in zip(data.get("text", []), data.get("conf", []), strict=False):
        word = str(raw_text).strip()
        if not word:
            continue
        try:
            confidence = float(raw_confidence)
        except (TypeError, ValueError):
            continue
        if confidence >= 0:
            words.append(OcrWord(text=word[:200], confidence=min(1, confidence / 100)))
    return PageResult(text=text, words=words)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": SERVICE_VERSION}


@app.post("/v1/recognize", response_model=RecognizeResponse, dependencies=[Depends(require_token)])
def recognize(payload: RecognizeRequest) -> RecognizeResponse:
    if payload.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="unsupported file type")
    document = decode_document(payload.content_base64)
    validate_signature(document, payload.mime_type)
    pages = render_pages(document, payload.mime_type, payload.max_pages)
    try:
        page_results = [recognize_page(page) for page in pages]
    finally:
        for page in pages:
            page.close()

    text = "\n\n".join(result.text for result in page_results if result.text).strip()
    words = [word for result in page_results for word in result.words][:50_000]
    if not text:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="no text found")
    confidence = sum(word.confidence for word in words) / len(words) if words else None
    return RecognizeResponse(
        text=text[:400_000],
        pages=len(pages),
        confidence=confidence,
        words=words,
        engine_version=SERVICE_VERSION,
    )
