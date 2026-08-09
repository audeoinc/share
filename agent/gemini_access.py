from google import genai

# 切り分け用に、ここだけ変えて試してください
PROJECT_ID = "audeodb"
LOCATION = "us"                 # "us" と "global" を切り替えて比較
MODEL = "gemini-3.5-flash"      # 必要に応じて変更


def main():
    print(f"[設定] project={PROJECT_ID}, location={LOCATION}, model={MODEL}")

    client = genai.Client(
        vertexai=True,
        project=PROJECT_ID,
        location=LOCATION,
    )

    response = client.models.generate_content(
        model=MODEL,
        contents="こんにちは。1行で自己紹介してください。",
    )

    print("\n[成功] 応答:")
    print(response.text)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("\n[失敗] エラーが発生しました:")
        print(repr(e))
