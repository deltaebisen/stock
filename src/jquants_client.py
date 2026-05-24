"""J-Quants API V2 クライアント。
V2はAPIキー方式（x-api-key ヘッダー）。トークン発行・リフレッシュは廃止。
レスポンスは原則として { "data": [...], "pagination_key": "..." } 構造。
"""
import os
import time
import requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

BASE_URL = "https://api.jquants.com/v2"


class JQuantsError(Exception):
    pass


class JQuantsClient:
    def __init__(self):
        api_key = os.environ.get("JQUANTS_API_KEY")
        if not api_key:
            raise JQuantsError(
                "JQUANTS_API_KEY が設定されていません。"
                "ダッシュボード(https://jpx-jquants.com/ja/dashboard)で発行してください。"
            )
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({"x-api-key": self.api_key})

        # リクエスト単位のレート制御 (Light: 60req/分 → 1.1秒間隔で安全マージン)
        rpm = int(os.environ.get("JQUANTS_RATE_PER_MIN", "60"))
        self._min_interval = 60.0 / max(rpm, 1)
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
    def _get(self, path, params=None):
        self._throttle()
        r = self.session.get(f"{BASE_URL}{path}", params=params, timeout=60)
        if r.status_code == 429:
            # 想定外の 429。少し長めに待ってリトライ (tenacity が拾う)
            time.sleep(15)
            r.raise_for_status()
        r.raise_for_status()
        return r.json()

    def _get_paginated(self, path, params=None, data_key="data"):
        """ページネーション対応で全データ取得 (レート制御は _get 内で実施)"""
        params = dict(params or {})
        all_items = []
        while True:
            resp = self._get(path, params=params)
            items = resp.get(data_key, [])
            all_items.extend(items)
            pagination_key = resp.get("pagination_key")
            if not pagination_key:
                break
            params["pagination_key"] = pagination_key
        return all_items

    def get_listed_info(self, date=None):
        """上場銘柄一覧 (V2: /equities/master)"""
        params = {}
        if date:
            params["date"] = date
        return self._get_paginated("/equities/master", params=params)

    def get_daily_quotes(self, code=None, from_date=None, to_date=None, date=None):
        """株価四本値 (V2: /equities/bars/daily)

        - date指定: その日の全銘柄
        - code指定: その銘柄の期間内
        """
        params = {}
        if code:
            params["code"] = code
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        if date:
            params["date"] = date
        return self._get_paginated("/equities/bars/daily", params=params)
