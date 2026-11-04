"""Download the page-orientation classifier's weights at image build time.

Its own script and Docker layer, after fetch_models.py, so adding it didn't
re-download the main OCR weights and editing the OCR code doesn't refetch it.
"""

from paddleocr import DocImgOrientationClassification

ORIENT_MODEL = "PP-LCNet_x1_0_doc_ori"  # keep in step with engine.py

if __name__ == "__main__":
    DocImgOrientationClassification(model_name=ORIENT_MODEL)
    print(f"[fetch_orient_model] {ORIENT_MODEL}: ok", flush=True)
