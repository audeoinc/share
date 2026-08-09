from google.cloud import bigquery
from google import genai

# プロジェクトとリージョンの設定（現在の環境に合わせています）
PROJECT_ID = "audeodb"
LOCATION = "global"  # Vertex AI の Gemini を利用するロケーション（"global" / "us" / "eu" / リージョン名）
MODEL = "gemini-3.1-flash-lite"  # 利用するモデル ID


def get_bq_data():
    """BigQuery からデータを取得し、文字列として返す関数"""
    # クライアントの初期化（Workbench 環境なら自動で認証されます）
    client = bigquery.Client(project=PROJECT_ID)

    # 対象のテーブルからデータを取得
    # ※LLM の入力文字数（トークン数）には上限があるため、まずは LIMIT をつけて少量のデータで試すのがおすすめです。
    query = """
        SELECT *
        FROM `audeodb.test_vir.sample_table`
        LIMIT 100
    """
    query_job = client.query(query)
    results = query_job.result()

    # データをテキスト形式に変換（見やすくする）
    data_str = ""
    for row in results:
        # ディクショナリ型に変換して文字列化
        data_str += str(dict(row)) + "\n"

    return data_str


def analyze_data_with_gemini(data):
    """取得したデータを Vertex AI (Gemini) に渡して分析する関数"""
    # Google Gen AI SDK のクライアントを初期化
    # vertexai=True で Vertex AI バックエンドを使用し、project / location を指定します。
    client = genai.Client(
        vertexai=True,
        project=PROJECT_ID,
        location=LOCATION,
    )

    # LLM への指示（プロンプト）を作成
    prompt = f"""
    あなたは優秀なデータアナリストです。
    以下のデータは BigQuery から抽出した「sample_table」のデータです。
    このデータの傾向、特徴、外れ値などを分析し、わかりやすくインサイトを提示してください。

    【データ】
    {data}
    """

    # LLM にリクエストを送信
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text


# メイン処理
if __name__ == "__main__":
    print("1. BigQuery からデータを取得中...")
    bq_data = get_bq_data()

    if not bq_data.strip():
        print("エラー: データが空です。テーブルにデータが入っているか確認してください。")
    else:
        print("2. データを Gemini に送信して分析中...")
        analysis_result = analyze_data_with_gemini(bq_data)

        print("\n================ 分析結果 ================\n")
        print(analysis_result)