# CPU-only gift-card OCR. There is deliberately no CUDA base image and no GPU
# runtime here: `paddlepaddle` (not `paddlepaddle-gpu`) is the CPU build, and
# the whole reason this approach was chosen over a vision-language model is
# that it does not need a GPU and so never contends with anything else on the
# host for one.
#
# python:3.11-slim-bookworm, not alpine: paddlepaddle publishes manylinux
# wheels only, so musl would mean building Paddle from source.
FROM python:3.11-slim-bookworm

# libgl1/libglib2.0-0 are for opencv-contrib-python, which paddleocr pulls in
# and which imports at module load even though nothing here draws anything.
# libgomp1 is Paddle's OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY variants.py pins.py engine.py server.py preload.py ./

# Fetch the OCR weights at build time. Without this the first request after
# every fresh container start blocks on a multi-hundred-MB download from
# PaddlePaddle's CDN, which on a home connection reads as "the service hung",
# and a container with no outbound internet would never work at all.
ENV PADDLE_PDX_MODEL_SOURCE=BOS
RUN python preload.py

ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    FLAGS_use_mkldnn=0 \
    OCR_MODEL_SET=medium \
    PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/health', timeout=8).status==200 else 1)"

CMD ["python", "server.py"]
