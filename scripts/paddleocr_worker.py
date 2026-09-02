#!/usr/bin/env python3
import json
import os
import sys
import traceback

PREFIX = "PORTARIASYNC_JSON:"


def emit(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_ocr_payload(value):
    """Procura rec_texts/rec_scores na estrutura retornada pelo PaddleOCR 3.x."""
    if isinstance(value, dict):
        texts = value.get("rec_texts")
        scores = value.get("rec_scores")
        if isinstance(texts, (list, tuple)):
            return list(texts), list(scores) if isinstance(scores, (list, tuple)) else []
        for child in value.values():
            found = find_ocr_payload(child)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for child in value:
            found = find_ocr_payload(child)
            if found:
                return found
    return None


def result_json(result):
    value = getattr(result, "json", None)
    if callable(value):
        value = value()
    if value is not None:
        return value
    if isinstance(result, dict):
        return result
    return {}


def build_engine():
    from paddleocr import PaddleOCR

    return PaddleOCR(
        lang=os.environ.get("PADDLE_OCR_LANG", "pt"),
        ocr_version=os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv5"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )


def recognize(engine, image_path):
    predictions = engine.predict(
        image_path,
        text_rec_score_thresh=float(os.environ.get("PADDLE_OCR_MIN_SCORE", "0.25")),
    )
    texts = []
    scores = []
    for prediction in predictions:
        found = find_ocr_payload(result_json(prediction))
        if not found:
            continue
        page_texts, page_scores = found
        for index, text in enumerate(page_texts):
            cleaned = str(text or "").strip()
            if not cleaned:
                continue
            texts.append(cleaned)
            if index < len(page_scores):
                try:
                    scores.append(float(page_scores[index]))
                except (TypeError, ValueError):
                    pass

    confidence = 0.0
    if scores:
        confidence = sum(scores) / len(scores)
        if confidence <= 1.0:
            confidence *= 100.0

    return {
        "text": "\n".join(texts),
        "confidence": round(confidence, 2),
        "lines": texts,
        "engine": "paddleocr",
        "ocrVersion": os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv5"),
        "language": os.environ.get("PADDLE_OCR_LANG", "pt"),
    }


def main():
    try:
        engine = build_engine()
        emit({"type": "ready", "engine": "paddleocr", "version": os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv5")})
    except Exception as exc:
        emit({"type": "startup_error", "error": str(exc), "detail": traceback.format_exc(limit=4)})
        return 2

    if "--check" in sys.argv:
        return 0

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            image_path = str(request.get("path") or "")
            if not request_id or not image_path or not os.path.isfile(image_path):
                raise ValueError("Arquivo de imagem inválido para o PaddleOCR.")
            result = recognize(engine, image_path)
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            emit({
                "id": request_id,
                "ok": False,
                "error": str(exc),
                "detail": traceback.format_exc(limit=4),
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
