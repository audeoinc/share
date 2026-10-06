# CCP(Campaign Contents Planner)の GCP 版: Cloud Run 用のコンテナ。
# 1 段目で画面(GCP 版のビルド)を作り、2 段目の Python のサーバーが、それを配信する(1 プロセス)。
#   gcloud run deploy contents-planner --source .   (手順は docs/GCP.md。普段は npm run deploy:gcp)

FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build --config vite.gcp.config.ts

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install -r server/requirements.txt
COPY server server
COPY --from=web /app/dist-gcp dist-gcp
WORKDIR /app/server
# Cloud Run は PORT(既定 8080)でリッスンさせる
ENV PORT=8080 \
    STATIC_DIR=/app/dist-gcp
CMD exec uvicorn ccp.main:app --host 0.0.0.0 --port ${PORT}
