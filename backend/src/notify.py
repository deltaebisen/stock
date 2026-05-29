"""シグナル検知 + Discord 通知バッチ。

`daily_quotes` の最新 trade_date を対象日として、スクリーニング後の銘柄に
指定の条件で発火した銘柄を Discord webhook に通知する。

default 動作 (引数なし):
  - 条件: MACD(20, 200, 10) の ゴールデンクロス (buy) + デッドクロス (sell)
  - 個別株スクリーニング: 東証プライム / 直近20日平均売買代金 ≥ 1B 円 / 当日 close ≤ 4000 円
  - ETF (sector33_code='9999') は **同じ流動性 / 価格条件で独立に抽出**。`--no-etf` で無効化
  - 添付ファイル: 個別株 buy/sell + ETF buy/sell の最大 4 ファイル

実行例:
  python -m src.notify
      # 上記 default

  python -m src.notify --conditions sma_cross_buy,volume_spike \\
      --max-price 2000 --min-turnover 500000000

  python -m src.notify --date 2026-05-29 --dry-run
      # 対象日を固定して Discord 送信せず stdout に流す (検証用)

条件:
  - `sma_cross_buy` / `sma_cross_sell` / `macd_cross_buy` / `macd_cross_sell` /
    `rsi_mean_reversion_buy` / `rsi_mean_reversion_sell`
      → backtest_strategies.py の戦略を流用して当日 (target_date) の signal を判定
  - `volume_spike`
      → 直近 window 日の平均出来高に対し当日が mult 倍以上で発火

パラメータは `cond:k=v,k=v;cond:k=v` 形式で `--params` に渡す。

スクリーニング:
  --market           市場フィルタ。market_code 完全一致 or market_name 前方一致
                     (例: 'プライム' / '0111')。空文字で無効化
  --min-turnover     直近 screen-days 日平均売買代金 (円) の下限
  --max-price        当日 close (調整済) の上限 (円)
  --screen-days      売買代金平均の対象営業日数 (default 20)

Webhook URL は `.env` の `DISCORD_WEBHOOK_URL` から読む。`--dry-run` か Webhook 未設定
なら stdout に出すだけで終了する。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
import requests
from sqlalchemy import text

from .backtest import load_quotes, resolve_universe
from .backtest_strategies import DEFAULT_PARAMS, make_strategy
from .db import get_engine


# -------------------------------------------------------------------
# 検知器 (Condition)
# -------------------------------------------------------------------


class Condition:
    """単一銘柄 OHLCV を受け取って最終日のシグナルを判定する基底。"""

    key: str = ""

    def evaluate(self, df: pd.DataFrame) -> dict[str, Any] | None:
        raise NotImplementedError

    def warmup(self) -> int:
        return 0


class StrategySignalCondition(Condition):
    """backtest_strategies.py の戦略を流用して最終日 signal を見る。"""

    def __init__(
        self, strategy_name: str, params: dict[str, Any], direction: str
    ) -> None:
        self.strategy_name = strategy_name
        self.direction = direction
        self.key = f"{strategy_name}_{direction}"
        self.strategy = make_strategy(strategy_name, params)

    def evaluate(self, df: pd.DataFrame) -> dict[str, Any] | None:
        if df.empty:
            return None
        signals = self.strategy.generate_signals(df)
        last = int(signals.iloc[-1]) if not pd.isna(signals.iloc[-1]) else 0
        want = 1 if self.direction == "buy" else -1
        if last != want:
            return None
        return {
            "signal": self.direction,
            "close": float(df["close"].iloc[-1]),
        }

    def warmup(self) -> int:
        return self.strategy.required_warmup()


class VolumeSpikeCondition(Condition):
    """直近 window 日平均出来高に対し当日が mult 倍以上なら発火。

    params:
      window   : 平均期間 (default 20)
      mult     : 倍率閾値 (default 3.0)
      min_avg  : 平均出来高の下限 (default 10000)。極端な低流動銘柄を除外
    """

    key = "volume_spike"

    def __init__(self, params: dict[str, Any]) -> None:
        self.window = int(params.get("window", 20))
        self.mult = float(params.get("mult", 3.0))
        self.min_avg = float(params.get("min_avg", 10000))

    def evaluate(self, df: pd.DataFrame) -> dict[str, Any] | None:
        if len(df) < self.window + 1:
            return None
        # 当日を除く直近 window 日の平均
        recent = df["volume"].iloc[-(self.window + 1) : -1]
        avg = float(recent.mean())
        if avg < self.min_avg:
            return None
        today_vol = float(df["volume"].iloc[-1])
        if today_vol <= 0:
            return None
        ratio = today_vol / avg
        if ratio < self.mult:
            return None
        return {
            "signal": "volume_spike",
            "volume": today_vol,
            "avg_volume": avg,
            "ratio": ratio,
            "close": float(df["close"].iloc[-1]),
        }

    def warmup(self) -> int:
        return self.window + 1


# -------------------------------------------------------------------
# 条件レジストリ
# -------------------------------------------------------------------

STRATEGY_BACKED = {"sma_cross", "macd_cross", "rsi_mean_reversion"}
VOLUME_SPIKE_DEFAULTS: dict[str, Any] = {"window": 20, "mult": 3.0, "min_avg": 10000}


def make_condition(name: str, params: dict[str, Any]) -> Condition:
    """`name` は 'sma_cross_buy' / 'volume_spike' 等。

    末尾 `_buy` / `_sell` を direction として剥がして残りを strategy 名と扱う。
    direction 無指定の戦略名は buy として解釈。
    """
    if name == "volume_spike":
        return VolumeSpikeCondition({**VOLUME_SPIKE_DEFAULTS, **params})

    if name.endswith("_buy"):
        strat, direction = name[: -len("_buy")], "buy"
    elif name.endswith("_sell"):
        strat, direction = name[: -len("_sell")], "sell"
    else:
        strat, direction = name, "buy"

    if strat in STRATEGY_BACKED:
        merged = {**DEFAULT_PARAMS.get(strat, {}), **params}
        return StrategySignalCondition(strat, merged, direction)

    raise ValueError(
        f"unknown condition: {name!r}. "
        f"available: volume_spike, "
        f"{', '.join(sorted(s + '_buy' for s in STRATEGY_BACKED))}, "
        f"{', '.join(sorted(s + '_sell' for s in STRATEGY_BACKED))}"
    )


# -------------------------------------------------------------------
# 検知オーケストレーション
# -------------------------------------------------------------------


@dataclass
class Hit:
    code: str
    condition: str
    detail: dict[str, Any]
    company_name: str | None = None
    is_etf: bool = False


def get_latest_trade_date(engine) -> date | None:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT MAX(trade_date) FROM daily_quotes")).fetchone()
    return row[0] if row and row[0] else None


def screen_by_market(
    engine, codes: list[str], market: str | None
) -> list[str]:
    """`listed_info` の market_code 完全一致 or market_name 前方一致でフィルタ。"""
    if not market or not codes:
        return codes
    placeholders = ", ".join(f":c{i}" for i in range(len(codes)))
    params: dict[str, Any] = {f"c{i}": c for i, c in enumerate(codes)}
    params["mkt"] = market
    sql = (
        f"SELECT code FROM listed_info "
        f"WHERE code IN ({placeholders}) "
        f"  AND (market_code = :mkt OR market_name LIKE CONCAT(:mkt, '%'))"
    )
    with engine.connect() as conn:
        return [r[0] for r in conn.execute(text(sql), params).fetchall()]


# J-Quants V2 で ETF は sector33_code='9999' (= "その他" 33業種区分外)
ETF_SECTOR33_CODE = "9999"


def screen_etfs(engine, codes: list[str]) -> list[str]:
    """`listed_info.sector33_code='9999'` の銘柄だけ抽出 (= ETF / ETN)。"""
    if not codes:
        return []
    placeholders = ", ".join(f":c{i}" for i in range(len(codes)))
    params: dict[str, Any] = {f"c{i}": c for i, c in enumerate(codes)}
    params["s33"] = ETF_SECTOR33_CODE
    sql = (
        f"SELECT code FROM listed_info "
        f"WHERE code IN ({placeholders}) AND sector33_code = :s33"
    )
    with engine.connect() as conn:
        return [r[0] for r in conn.execute(text(sql), params).fetchall()]


def screen_by_liquidity_and_price(
    engine,
    codes: list[str],
    target_date: date,
    screen_days: int,
    min_avg_turnover: float | None,
    max_price: float | None,
) -> list[str]:
    """直近 screen_days 営業日の平均売買代金 + 当日 close (調整済) でフィルタ。

    SQL 集計で全コードに対し AVG(turnover_value) と当日 adjustment_close を計算し、
    閾値で篩い落とす。MariaDB 側で集計するので 4000 銘柄でも軽い。

    AVG の対象期間は `target_date - screen_days*1.5 暦日` 〜 `target_date` の全行 ≒
    直近 screen_days 営業日 (祝祭日があると多少前後する)。
    """
    if not codes or (min_avg_turnover is None and max_price is None):
        return codes

    from_date = target_date - timedelta(days=int(screen_days * 1.5))
    placeholders = ", ".join(f":c{i}" for i in range(len(codes)))
    params: dict[str, Any] = {f"c{i}": c for i, c in enumerate(codes)}
    params["target_date"] = target_date
    params["from_date"] = from_date

    sql = (
        f"SELECT code, "
        f"  AVG(turnover_value) AS avg_turnover, "
        f"  MAX(CASE WHEN trade_date = :target_date THEN adjustment_close END) AS last_close "
        f"FROM daily_quotes "
        f"WHERE code IN ({placeholders}) "
        f"  AND trade_date BETWEEN :from_date AND :target_date "
        f"GROUP BY code"
    )
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).fetchall()

    out: list[str] = []
    for code, avg_t, last_close in rows:
        # 当日値が無い銘柄 (売買停止 / 上場廃止) は除外
        if last_close is None:
            continue
        if min_avg_turnover is not None and (
            avg_t is None or float(avg_t) < min_avg_turnover
        ):
            continue
        if max_price is not None and float(last_close) > max_price:
            continue
        out.append(code)
    return out


def fetch_company_names(engine, codes: list[str]) -> dict[str, str]:
    if not codes:
        return {}
    placeholders = ", ".join(f":c{i}" for i in range(len(codes)))
    params = {f"c{i}": c for i, c in enumerate(codes)}
    sql = f"SELECT code, company_name FROM listed_info WHERE code IN ({placeholders})"
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).fetchall()
    return {r[0]: (r[1] or "") for r in rows}


def detect(
    engine,
    codes: list[str],
    conditions: list[Condition],
    target_date: date,
    lookback_days: int,
) -> list[Hit]:
    from_date = target_date - timedelta(days=lookback_days)
    data = load_quotes(engine, codes, from_date, target_date)

    target_ts = pd.Timestamp(target_date)
    hits: list[Hit] = []
    for code, df in data.items():
        # 当日値が無い銘柄はスキップ (上場廃止 / 売買停止)
        if df.empty or df.index[-1] != target_ts:
            continue
        for cond in conditions:
            result = cond.evaluate(df)
            if result is not None:
                hits.append(Hit(code=code, condition=cond.key, detail=result))
    return hits


# -------------------------------------------------------------------
# Discord 通知
# -------------------------------------------------------------------

# Discord メッセージは 2000 文字制限。余裕を見て 1800 でチャンク。
MAX_MESSAGE_CHARS = 1800
# 条件ごとに表示する最大件数 (これを超えたら ratio / 50音順で上位のみ + 件数表示)
MAX_PER_CONDITION_DISPLAY = 50


def _format_hit_line(h: Hit) -> str:
    name = (h.company_name or "")[:18]
    d = h.detail
    extras: list[str] = []
    if "close" in d:
        extras.append(f"¥{d['close']:,.0f}")
    if "ratio" in d:
        extras.append(f"vol×{d['ratio']:.1f}")
    suffix = (" / ".join(extras)) if extras else ""
    return f"`{h.code}` {name} {suffix}".rstrip()


def format_hits(hits: list[Hit], target_date: date) -> list[str]:
    """Discord に送る複数メッセージにチャンク化。(is_etf, condition) 単位でセクション化。"""
    if not hits:
        return [f"📊 **{target_date}** シグナル検知 0 件"]

    # (is_etf, condition) → [Hit]
    grouped: dict[tuple[bool, str], list[Hit]] = {}
    for h in hits:
        grouped.setdefault((h.is_etf, h.condition), []).append(h)

    # volume_spike は ratio 降順、他は close 降順で並べる
    for key, group in grouped.items():
        cond = key[1]
        if cond == "volume_spike":
            group.sort(key=lambda h: h.detail.get("ratio", 0), reverse=True)
        else:
            group.sort(key=lambda h: -h.detail.get("close", 0))

    n_equity = sum(1 for h in hits if not h.is_etf)
    n_etf = sum(1 for h in hits if h.is_etf)
    header = (
        f"📊 **{target_date}** シグナル検知 "
        f"(個別 {n_equity} 件 / ETF {n_etf} 件)"
    )
    sections: list[str] = []
    # equity 系を先、ETF 系を後にまとめる。各カテゴリ内は condition 名で sort
    for is_etf in (False, True):
        keys = sorted(k for k in grouped.keys() if k[0] == is_etf)
        for key in keys:
            group = grouped[key]
            shown = group[:MAX_PER_CONDITION_DISPLAY]
            body = "\n".join(_format_hit_line(h) for h in shown)
            if len(group) > len(shown):
                body += f"\n... +{len(group) - len(shown)} 件"
            label = ("ETF " if is_etf else "") + key[1]
            sections.append(f"\n__**{label}**__ ({len(group)} 件)\n{body}")

    # ヘッダ + セクション群を MAX_MESSAGE_CHARS 単位に分割
    messages: list[str] = []
    current = header
    for sec in sections:
        if len(current) + len(sec) > MAX_MESSAGE_CHARS:
            messages.append(current)
            current = sec.lstrip("\n")
        else:
            current += sec
    if current:
        messages.append(current)
    return messages


def build_watchlist_files(
    hits: list[Hit], target_date: date
) -> list[tuple[str, bytes]]:
    """TradingView 用ウォッチリストを生成。

    生成ファイル (該当 0 件の側はスキップ):
      - `YYYY-MM-DD buy.txt`      : 個別株 buy
      - `YYYY-MM-DD sell.txt`     : 個別株 sell
      - `YYYY-MM-DD etf-buy.txt`  : ETF buy
      - `YYYY-MM-DD etf-sell.txt` : ETF sell

    - フォーマット: `TSE:<コード>` 1 行 1 銘柄 (東証銘柄前提)
    - `_sell` 終わりの condition は sell、それ以外は buy
    - 重複コードは除去、当日 close **降順** (同値は code 昇順)
    - ファイル名は TradingView インポート時にそのままウォッチリスト名になる
    """
    # (is_etf, is_sell) → {code: close}
    buckets: dict[tuple[bool, bool], dict[str, float]] = {
        (False, False): {},  # equity buy
        (False, True): {},   # equity sell
        (True, False): {},   # etf buy
        (True, True): {},    # etf sell
    }
    for h in hits:
        close = float(h.detail.get("close", 0.0))
        is_sell = h.condition.endswith("_sell")
        buckets[(h.is_etf, is_sell)][h.code] = close

    date_str = target_date.isoformat()
    name_map = {
        (False, False): "buy",
        (False, True): "sell",
        (True, False): "etf-buy",
        (True, True): "etf-sell",
    }
    out: list[tuple[str, bytes]] = []
    for key, mapping in buckets.items():
        if not mapping:
            continue
        ordered = sorted(mapping.items(), key=lambda kv: (-kv[1], kv[0]))
        body = "\n".join(f"TSE:{code}" for code, _ in ordered)
        out.append((f"{date_str} {name_map[key]}.txt", body.encode("utf-8")))
    return out


def send_to_discord(
    webhook_url: str,
    content: str,
    files: list[tuple[str, bytes]] | None = None,
) -> None:
    """Discord webhook に POST。`files` 指定時は multipart/form-data で添付。"""
    if files:
        multipart = {
            f"files[{i}]": (name, data, "text/plain")
            for i, (name, data) in enumerate(files)
        }
        resp = requests.post(
            webhook_url,
            data={"payload_json": json.dumps({"content": content})},
            files=multipart,
            timeout=30,
        )
    else:
        resp = requests.post(webhook_url, json={"content": content}, timeout=15)
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Discord webhook {resp.status_code}: {resp.text[:200]}"
        )


# -------------------------------------------------------------------
# CLI
# -------------------------------------------------------------------


def _parse_kv(s: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not s:
        return out
    for pair in s.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip()
        try:
            out[k] = int(v)
            continue
        except ValueError:
            pass
        try:
            out[k] = float(v)
            continue
        except ValueError:
            pass
        out[k] = v
    return out


def _parse_cond_params(s: str) -> dict[str, dict[str, Any]]:
    """'sma_cross_buy:fast=25,slow=75;volume_spike:window=20,mult=3.0' → dict"""
    out: dict[str, dict[str, Any]] = {}
    if not s:
        return out
    for block in s.split(";"):
        block = block.strip()
        if not block or ":" not in block:
            continue
        name, kv = block.split(":", 1)
        out[name.strip()] = _parse_kv(kv)
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="notify", description="シグナル検知 + Discord 通知"
    )
    p.add_argument(
        "--conditions",
        default="macd_cross_buy,macd_cross_sell",
        help="カンマ区切り。default: macd_cross_buy,macd_cross_sell",
    )
    p.add_argument(
        "--params",
        default=(
            "macd_cross_buy:fast=20,slow=200,signal=10;"
            "macd_cross_sell:fast=20,slow=200,signal=10"
        ),
        help="条件別パラメータ。'cond:k=v,k=v;cond:k=v' 形式",
    )
    p.add_argument(
        "--universe",
        default="all",
        help="universe spec (backtest と同じ書式)。default: all (スクリーニングで絞る)",
    )
    p.add_argument(
        "--market",
        default="プライム",
        help="市場フィルタ (個別株)。market_code 完全一致 or market_name 前方一致 (例: 'プライム' / '0111')。空文字で無効",
    )
    p.add_argument(
        "--no-etf",
        action="store_true",
        help="ETF (sector33_code='9999') の抽出を無効化",
    )
    p.add_argument(
        "--min-turnover",
        type=float,
        default=1_000_000_000.0,
        help="直近 screen-days 平均売買代金 (円) の下限。default: 1e9 (=10億)。0 で無効",
    )
    p.add_argument(
        "--max-price",
        type=float,
        default=4000.0,
        help="当日 close (調整済) の上限 (円)。default: 4000。0 で無効",
    )
    p.add_argument(
        "--screen-days",
        type=int,
        default=20,
        help="売買代金平均の対象営業日数 (default 20)",
    )
    p.add_argument(
        "--date",
        default=None,
        help="検知対象日 YYYY-MM-DD (default: daily_quotes の最新日)",
    )
    p.add_argument(
        "--lookback-days",
        type=int,
        default=400,
        help="DB ロード履歴日数 (default 400 = MACD(_,200,_) の warmup 用)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Discord 送信せず stdout に出力",
    )
    p.add_argument(
        "--webhook-url",
        default=None,
        help="DISCORD_WEBHOOK_URL の上書き (テスト用)",
    )
    args = p.parse_args(argv)

    engine = get_engine()

    # 対象日
    if args.date:
        target_date = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        latest = get_latest_trade_date(engine)
        if latest is None:
            print("[notify][FATAL] daily_quotes が空", file=sys.stderr)
            return 1
        target_date = latest
    print(f"[notify] target_date={target_date}")

    # 条件構築
    cond_params = _parse_cond_params(args.params)
    cond_names = [n.strip() for n in args.conditions.split(",") if n.strip()]
    conditions = [make_condition(n, cond_params.get(n, {})) for n in cond_names]
    print(f"[notify] conditions={[c.key for c in conditions]}")

    # universe
    universe_codes = resolve_universe(engine, args.universe)
    if not universe_codes:
        print(f"[notify][FATAL] universe '{args.universe}' で 0 銘柄", file=sys.stderr)
        return 1
    print(f"[notify] universe={args.universe} → {len(universe_codes)} 銘柄")

    min_turn = args.min_turnover if args.min_turnover and args.min_turnover > 0 else None
    max_price = args.max_price if args.max_price and args.max_price > 0 else None

    def _apply_liquidity(label: str, codes: list[str]) -> list[str]:
        if min_turn is None and max_price is None:
            return codes
        codes = screen_by_liquidity_and_price(
            engine, codes, target_date, args.screen_days, min_turn, max_price
        )
        cond_str = []
        if min_turn:
            cond_str.append(f"avg_turnover≥{min_turn:,.0f}")
        if max_price:
            cond_str.append(f"close≤{max_price:,.0f}")
        print(f"[notify] {label} after {'/'.join(cond_str)} → {len(codes)} 銘柄")
        return codes

    # 個別株: 市場フィルタ → 流動性 / 価格
    equity_market = args.market.strip() if args.market else None
    if equity_market:
        equity_codes = screen_by_market(engine, universe_codes, equity_market)
        print(
            f"[notify] equity after market='{equity_market}' → {len(equity_codes)} 銘柄"
        )
    else:
        equity_codes = universe_codes
    equity_codes = _apply_liquidity("equity", equity_codes)

    # ETF: sector33_code='9999' → 流動性 / 価格 (同じ閾値)
    if args.no_etf:
        etf_codes: list[str] = []
    else:
        etf_codes = screen_etfs(engine, universe_codes)
        print(f"[notify] etf after sector33='{ETF_SECTOR33_CODE}' → {len(etf_codes)} 銘柄")
        etf_codes = _apply_liquidity("etf", etf_codes)
    etf_set = set(etf_codes)
    # detect は重複させても無駄なので union
    all_codes = list(dict.fromkeys(equity_codes + etf_codes))
    if not all_codes:
        print("[notify] スクリーニング後 0 銘柄", file=sys.stderr)

    # lookback (warmup 営業日 × 1.6 + 余裕 30 を暦日換算の最低ラインに)
    max_warmup = max((c.warmup() for c in conditions), default=0)
    needed = int(max_warmup * 1.6) + 30
    lookback = max(args.lookback_days, needed)
    print(f"[notify] lookback={lookback} days (max warmup bars={max_warmup})")

    hits = detect(engine, all_codes, conditions, target_date, lookback)
    for h in hits:
        h.is_etf = h.code in etf_set
    print(
        f"[notify] detected {len(hits)} hits "
        f"(equity={sum(1 for h in hits if not h.is_etf)}, "
        f"etf={sum(1 for h in hits if h.is_etf)})"
    )

    if hits:
        unique = sorted({h.code for h in hits})
        names = fetch_company_names(engine, unique)
        for h in hits:
            h.company_name = names.get(h.code)

    messages = format_hits(hits, target_date)
    attachments = build_watchlist_files(hits, target_date)
    webhook = args.webhook_url or os.environ.get("DISCORD_WEBHOOK_URL")

    if args.dry_run or not webhook:
        if not webhook and not args.dry_run:
            print(
                "[notify][WARN] DISCORD_WEBHOOK_URL 未設定。stdout 出力に fallback",
                file=sys.stderr,
            )
        for m in messages:
            print(m)
            print("---")
        for name, data in attachments:
            print(f"=== {name} ===")
            print(data.decode("utf-8"))
            print("---")
        return 0

    # 添付は最初のメッセージにのみ付ける (Discord 上で本文の下に表示される)
    for i, m in enumerate(messages):
        files = attachments if i == 0 else None
        send_to_discord(webhook, m, files)
    print(
        f"[notify] sent {len(messages)} message(s) to Discord "
        f"(attachments: {[n for n, _ in attachments]})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
