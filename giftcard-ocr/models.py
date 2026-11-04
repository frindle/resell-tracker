"""OCR model names and PaddleOCR options.

Kept apart from engine.py so the image layer that downloads the weights
(fetch_models.py) only rebuilds when the models change, not on every edit to
the OCR code.
"""

PADDLE_KWARGS = dict(
    lang="en",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=False,
)

MODEL_SETS = {
    "medium": dict(
        text_detection_model_name="PP-OCRv6_medium_det",
        text_recognition_model_name="PP-OCRv6_medium_rec",
    ),
    "mobile": dict(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
    ),
}
