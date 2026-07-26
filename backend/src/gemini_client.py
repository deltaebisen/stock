"""Gemini API クライアント (テーマ分類バッチ用)。

認証: `x-goog-api-key` ヘッダ。エンドポイントは generateContent 1 本だけ。

**SDK (google-genai) は入れない**。requirements.txt を変えると worker イメージの
再ビルドが必要になるが、deploy workflow は web-rebuild しかしないので NAS 側の
イメージが更新されず ModuleNotFoundError を踏む (CLAUDE.md 参照)。使うのが
1 エンドポイントだけなので requests で十分。

環境変数:
    GEMINI_API_KEY       必須。https://aistudio.google.com/apikey で発行
    GEMINI_MODEL         デフォルト gemini-2.5-flash-lite
    GEMINI_RATE_PER_MIN  デフォルト 10 (無料枠の RPM に収まる控えめな値)
"""
import json
import os
import time
from typing import Any

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-2.5-flash-lite"


class GeminiError(Exception):
    pass


class GeminiResponseError(GeminiError):
    """レスポンスは返ったが中身が使えない (MAX_TOKENS で切れた等)。バッチ側で分割リトライする。"""


class GeminiQuotaError(GeminiError):
    """日次クォータ超過。待っても当日は回復しないので、ジョブごと打ち切る。

    無料枠は「モデルごと・プロジェクトごとの 1 日あたりリクエスト数」で切られており
    (quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier)、リトライは無意味。
    1 リクエストあたりの銘柄数を増やすか、翌日に回すか、課金を有効にする。
    """


def _quota_info(r: requests.Response) -> dict[str, Any]:
    """429 レスポンスから「日次かどうか」と retryDelay を取り出す。"""
    out: dict[str, Any] = {
        "per_day": False,
        "value": None,
        "retry_after": None,
        "depleted": False,
    }
    try:
        err = r.json().get("error", {})
    except ValueError:
        return out
    # 前払いクレジット切れは details を持たず message だけで来る
    if "credits are depleted" in (err.get("message") or ""):
        out["depleted"] = True
        return out
    details = err.get("details", [])
    for d in details:
        t = d.get("@type", "")
        if t.endswith("QuotaFailure"):
            for v in d.get("violations", []):
                if "PerDay" in (v.get("quotaId") or ""):
                    out["per_day"] = True
                    out["value"] = v.get("quotaValue")
        elif t.endswith("RetryInfo"):
            delay = str(d.get("retryDelay", "")).rstrip("s")
            try:
                out["retry_after"] = float(delay)
            except ValueError:
                pass
    return out


class GeminiClient:
    def __init__(self, model: str | None = None):
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise GeminiError(
                "GEMINI_API_KEY が設定されていません。"
                "https://aistudio.google.com/apikey で発行して .env に入れてください。"
            )
        self.api_key = api_key
        self.model = model or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
        self.session = requests.Session()

        rpm = float(os.environ.get("GEMINI_RATE_PER_MIN", "10"))
        self._min_interval = 60.0 / max(rpm, 1.0)
        self._last_request_time = 0.0
        # 使用トークンの累計 (ジョブ終了時にコスト把握のため出す)
        self.prompt_tokens = 0
        self.output_tokens = 0

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_time
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request_time = time.monotonic()

    @retry(
        stop=stop_after_attempt(5),
        wait=wait_exponential(min=2, max=60),
        retry=retry_if_exception_type(requests.exceptions.RequestException),
    )
    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._throttle()
        url = f"{BASE_URL}/{self.model}:generateContent"
        r = self.session.post(
            url,
            headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
            json=payload,
            timeout=180,
        )
        if r.status_code == 429:
            info = _quota_info(r)
            if info["depleted"]:
                # 前払いクレジット切れ。残高を足すまで何度投げても同じ
                raise GeminiQuotaError(
                    "前払いクレジットが尽きています。"
                    "https://ai.studio/projects で残高を追加してください"
                )
            if info["per_day"]:
                # 日次クォータは待っても当日は回復しない
                raise GeminiQuotaError(
                    f"日次クォータ超過 (model={self.model}, limit={info['value']}/day)。"
                    "GEMINI_BATCH_SIZE を上げて 1 日のリクエスト数を減らすか、"
                    "翌日に回すか、課金を有効にしてください"
                )
            # 分あたりのレート超過。サーバが提示する retryDelay があればそれに従う
            time.sleep(info["retry_after"] or 20)
            raise requests.exceptions.RequestException(
                f"429 rate limited (retry in {info['retry_after']}s)"
            )
        if r.status_code >= 500:
            raise requests.exceptions.RequestException(f"{r.status_code}: {r.text[:200]}")
        if r.status_code != 200:
            # 4xx は再試行しても直らない (キー不正・スキーマ不正等)
            raise GeminiError(f"HTTP {r.status_code}: {r.text[:500]}")
        return r.json()

    def generate_json(
        self,
        system_instruction: str,
        user_text: str,
        response_schema: dict[str, Any],
        max_output_tokens: int = 8192,
    ) -> Any:
        """構造化出力 (JSON) を 1 回だけ取る。パース済みの Python オブジェクトを返す。

        - `responseSchema` でスキーマを強制するので、プロンプトで JSON を懇願する必要は無い
        - `thinkingBudget: 0` は必須。2.5 系は既定で thinking トークンを使い、単純分類でも
          出力課金が数倍になるうえ maxOutputTokens を食い潰して MAX_TOKENS 切断を招く
        - `temperature: 0` で実行間の揺れを抑える (再実行時に差分が読めるようにする)
        """
        payload = {
            "systemInstruction": {"parts": [{"text": system_instruction}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseSchema": response_schema,
                "maxOutputTokens": max_output_tokens,
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
        data = self._post(payload)

        usage = data.get("usageMetadata") or {}
        self.prompt_tokens += int(usage.get("promptTokenCount") or 0)
        self.output_tokens += int(
            (usage.get("candidatesTokenCount") or 0) + (usage.get("thoughtsTokenCount") or 0)
        )

        candidates = data.get("candidates") or []
        if not candidates:
            raise GeminiResponseError(f"candidates が空: {json.dumps(data)[:300]}")

        cand = candidates[0]
        finish = cand.get("finishReason")
        if finish not in (None, "STOP"):
            # MAX_TOKENS / SAFETY 等。バッチを分割して呼び直す判断は呼び出し側
            raise GeminiResponseError(f"finishReason={finish}")

        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        if not text:
            raise GeminiResponseError("空のレスポンス")

        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise GeminiResponseError(f"JSON パース失敗: {e}: {text[:300]}")
