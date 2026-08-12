"""アプリ全体の設定値。環境変数で上書きできます。"""
import os

# 利用する Gemini モデル。Gemini 3.5 系を想定。
# 実在するモデルIDに合わせて .env / デプロイ時の環境変数で調整してください。
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
