from __future__ import annotations

import base64
import binascii
import io
import os
import re
import secrets
from dataclasses import dataclass
from typing import Annotated, Literal

import pypdfium2 as pdfium
import pytesseract
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field
from pytesseract import Output

SERVICE_VERSION = "tesseract-v3"
MAX_FILE_BYTES = int(os.getenv("OCR_SERVICE_MAX_FILE_BYTES", str(4 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("OCR_SERVICE_MAX_PAGES", "5"))
MAX_PIXELS = int(os.getenv("OCR_SERVICE_MAX_PIXELS", "40000000"))
MAX_REQUEST_BYTES = 6 * 1024 * 1024
DEFAULT_LANGUAGES = "kaz+rus+eng"
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


def authorization_problem(header: str) -> tuple[int, str, bool] | None:
    """Returns (status, detail, send WWW-Authenticate) when the Authorization header is not acceptable."""
    configured = os.getenv("OCR_SERVICE_TOKEN", "")
    if len(configured) < 32:
        return status.HTTP_503_SERVICE_UNAVAILABLE, "service is not configured", False
    supplied = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, configured):
        return status.HTTP_401_UNAUTHORIZED, "unauthorized", True
    return None


class _BodyTooLarge(Exception):
    pass


class RequestGuard:
    """Refuses bad callers before their body is read and caps how much of a body is ever read.

    Checking only Content-Length is not enough: a chunked request has none, and FastAPI validates the whole body
    before it runs the token dependency. Both happen here, at the ASGI level, ahead of any parsing.
    """

    def __init__(self, app):
        self.app = app

    @staticmethod
    async def _respond(send, code: int, detail: str, authenticate: bool = False) -> None:
        body = JSONResponse({"detail": detail}).body
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        if authenticate:
            headers.append((b"www-authenticate", b"Bearer"))
        await send({"type": "http.response.start", "status": code, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope["headers"]}
        if scope["path"].startswith("/v1/"):
            problem = authorization_problem(headers.get(b"authorization", b"").decode("latin-1"))
            if problem:
                await self._respond(send, problem[0], problem[1], problem[2])
                return
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > MAX_REQUEST_BYTES:
                    await self._respond(send, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "request too large")
                    return
            except ValueError:
                await self._respond(send, status.HTTP_400_BAD_REQUEST, "invalid content length")
                return

        received = 0
        responded = False

        async def limited_receive():
            nonlocal received, responded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_REQUEST_BYTES and not responded:
                    # Answer at once: the framework would turn the interruption into a generic 400.
                    responded = True
                    await self._respond(send, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "request too large")
                    raise _BodyTooLarge
            return message

        async def guarded_send(message):
            # After the 413 nothing else may be written to this connection.
            if not responded:
                await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _BodyTooLarge:
            pass


app.add_middleware(RequestGuard)


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    # The guard above already refused bad callers; this stays as a second line of defence for direct use.
    problem = authorization_problem(authorization or "")
    if problem:
        code, detail, authenticate = problem
        raise HTTPException(status_code=code, detail=detail, headers={"WWW-Authenticate": "Bearer"} if authenticate else None)


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
    extras: list[str] = []
    if re.search(r"УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ|ЖЕКЕ\s+КУӘЛІК", text, re.IGNORECASE):
        # Kazakhstan identity cards use a stable two-sided layout. A sparse full-page pass often
        # misses the small number on the upper-right of the reverse side, so read that zone alone.
        width, height = image.size
        number_zone = image.crop((int(width * 0.60), int(height * 0.39), int(width * 0.99), int(height * 0.58)))
        number_zone = ImageOps.autocontrast(ImageOps.grayscale(number_zone)).resize(
            (number_zone.width * 2, number_zone.height * 2), Image.Resampling.LANCZOS
        )
        number_text = pytesseract.image_to_string(
            number_zone,
            lang="eng",
            config="--oem 1 --psm 11 -c tessedit_char_whitelist=0123456789",
        )
        candidates = []
        for line in number_text.splitlines():
            digits = re.sub(r"\D", "", line)
            if len(digits) == 9:
                candidates.append(digits)
        if candidates:
            extras.append(f"NEXUS_DOCUMENT_NUMBER: {candidates[0]}")

        # Read the labelled name block with Kazakh first so І/Ұ/Ә/Ө/Ү/Қ/Ғ/Ң are not needlessly
        # replaced by Russian look-alikes. The main pass is retained as a fallback.
        name_zone = image.crop((int(width * 0.34), int(height * 0.12), int(width * 0.97), int(height * 0.42)))
        name_zone = ImageOps.autocontrast(ImageOps.grayscale(name_zone)).resize(
            (name_zone.width * 2, name_zone.height * 2), Image.Resampling.LANCZOS
        )
        name_text = pytesseract.image_to_string(name_zone, lang="kaz+rus", config="--oem 1 --psm 6").strip()
        if name_text:
            extras.append(name_text)
    combined = "\n".join([*extras, text]).strip()
    return PageResult(text=combined, words=words)


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
