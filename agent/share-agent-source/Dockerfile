# Cloud Run 用コンテナ（FastAPI 単一プロセス。json-server は不要）
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . ./

# Cloud Run は PORT 環境変数（既定 8080）でリッスンさせる
ENV PORT=8080
CMD exec uvicorn server.main:app --host 0.0.0.0 --port ${PORT}
