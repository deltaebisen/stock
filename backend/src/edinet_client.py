"""EDINET API v2 クライアント。

認証: Subscription-Key (クエリパラメータで渡す。ヘッダではない)。
ドキュメント: https://disclosure2.edinet-fsa.go.jp/weee0030.aspx

公式の rate limit は明示されていないが、安全側で 1 req/sec (環境変数で調整可)。
ドキュメントリスト (/api/v2/documents.json) は軽いが、ZIP ダウンロードは重いので
ダウンロード時は別途配慮する。
"""
import os
import time
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

BASE_URL = "https://disclosure.edinet-fsa.go.jp/api/v2"

# EDINET 公式コード一覧 (CSV ZIP)。API ではなく直リンク。
CODE_LIST_URL = (
    "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"
)


class EdinetError(Exception):
    pass


class EdinetClient:
    def __init__(self):
        api_key = os.environ.get("EDINET_API_KEY")
        if not api_key:
            raise EdinetError(
                "EDINET_API_KEY が設定されていません。"
                "https://disclosure2.edinet-fsa.go.jp/weee0030.aspx で発行してください。"
            )
        self.api_key = api_key
        self.session = requests.Session()

        rps = float(os.environ.get("EDINET_RATE_PER_SEC", "1"))
        self._min_interval = 1.0 / max(rps, 0.1)
        self._last_request_time = 0.0

    def _throttle(self):
        elapsed = time.monotonic() - self._last_request_time
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request_time = time.monotonic()

    @retry(
        stop=stop_after_attempt(5),
        wait=wait_exponential(min=2, max=30),
        retry=retry_if_exception_type(requests.exceptions.RequestException),
    )
    def _get(self, path: str, params: dict | None = None, stream: bool = False) -> requests.Response:
        self._throttle()
        params = dict(params or {})
        # EDINET API v2 は Subscription-Key をクエリで渡す
        params["Subscription-Key"] = self.api_key
        r = self.session.get(f"{BASE_URL}{path}", params=params, timeout=120, stream=stream)
        if r.status_code == 429:
            time.sleep(15)
            r.raise_for_status()
        r.raise_for_status()
        return r

    def list_documents(self, date: str, doc_type: int = 2) -> dict[str, Any]:
        """指定日の提出書類一覧 (/api/v2/documents.json)

        doc_type:
          1 = メタデータのみ
          2 = メタデータ + 書類一覧 (これを使う)

        date: YYYY-MM-DD
        Returns: {metadata: {...}, results: [{docID, secCode, edinetCode, ...}, ...]}
        """
        r = self._get("/documents.json", params={"date": date, "type": doc_type})
        return r.json()

    def download_document(self, doc_id: str, doc_type: int = 1) -> bytes:
        """書類本体をダウンロード (/api/v2/documents/{docID})

        doc_type:
          1 = XBRL (ZIP) ← Phase 2 で使う
          2 = PDF
          5 = CSV (一部の書類のみ)
        """
        r = self._get(f"/documents/{doc_id}", params={"type": doc_type}, stream=True)
        return r.content

    @classmethod
    def download_code_list(cls) -> bytes:
        """EDINET 公式の事業者コード一覧 (ZIP) を直 URL からダウンロード。
        API キーは不要。session も使い回さなくて良いので classmethod。
        """
        r = requests.get(CODE_LIST_URL, timeout=120)
        r.raise_for_status()
        return r.content
