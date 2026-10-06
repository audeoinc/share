"""Google Cloud の認証情報。Cloud Run では、実行サービスアカウント(ADC)が使われる。

手元(ローカル)だけ、環境変数 CCP_DEV_GCLOUD=1 で、
`gcloud auth print-access-token` の短期トークン(約 1 時間)を使える。本番では使わない。
"""
from __future__ import annotations

import os
import shutil
import subprocess

import google.auth
from google.auth.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def get_credentials() -> Credentials:
    # 手元の開発用: ADC が期限切れでも使える、gcloud の短期トークン(本番では、この環境変数を設定しない)
    if os.getenv("CCP_DEV_GCLOUD") == "1":
        from google.oauth2.credentials import Credentials as UserCredentials

        gcloud = shutil.which("gcloud") or shutil.which("gcloud.cmd") or "gcloud"
        token = subprocess.run([gcloud, "auth", "print-access-token"], capture_output=True, text=True, check=True, shell=os.name == "nt").stdout.strip()
        return UserCredentials(token=token)
    creds, _ = google.auth.default(scopes=SCOPES)
    return creds
