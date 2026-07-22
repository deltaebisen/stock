"""バックテスト戦略 (long-only シグナル生成器)。

各 Strategy は単一銘柄の OHLC DataFrame を受け取り、
'signal' 列を持つ DataFrame を返す。signal の値は:
    +1 = 当日 close で entry (買い)
    -1 = 当日 close で exit (売り)
     0 = hold

エンジン (backtest.py) はこの signal をそのまま解釈して event-driven に
ポジションを変動させる。複数日連続で +1 が出ても、エンジン側で「既に
ポジション保有中なら無視」と扱うのでシグナル発信側は冪等性を気にしなくて良い。

新戦略を追加する場合:
  1. Strategy サブクラスを定義
  2. STRATEGIES 辞書に登録
  3. (任意) DEFAULT_PARAMS にデフォルトを書く
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from typing import Any

import numpy as np
import pandas as pd


class Strategy(ABC):
    """1 銘柄の OHLC を受け取って signal 列を埋める基底クラス。"""

    name: str = ""

    def __init__(self, params: dict[str, Any]) -> None:
        # 未指定は DEFAULT_PARAMS から補完
        defaults = DEFAULT_PARAMS.get(self.name, {})
        self.params = {**defaults, **params}

    @abstractmethod
    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        """df: columns >= [close]。Returns: signal Series (int, df.index と同じ)"""

    def required_warmup(self) -> int:
        """シグナルが安定するまでのバー数 (バックテスト開始から無視する日数)。"""
        return 0


# -------------------------------------------------------------------
# 個別戦略
# -------------------------------------------------------------------


class SmaCrossStrategy(Strategy):
    """単純移動平均線のクロス。

    fast SMA が slow SMA を下から上に抜けたら買い、上から下に抜けたら売り。
    fast < slow が前提 (params で逆に渡すと意味のないシグナルになる)。
    """

    name = "sma_cross"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        fast_period = int(self.params["fast"])
        slow_period = int(self.params["slow"])
        close = df["close"].astype(float)
        fast = close.rolling(fast_period, min_periods=fast_period).mean()
        slow = close.rolling(slow_period, min_periods=slow_period).mean()

        diff = fast - slow
        prev_diff = diff.shift(1)
        cross_up = (prev_diff <= 0) & (diff > 0)
        cross_down = (prev_diff >= 0) & (diff < 0)

        signal = pd.Series(0, index=df.index, dtype=int)
        signal[cross_up] = 1
        signal[cross_down] = -1
        return signal

    def required_warmup(self) -> int:
        return int(self.params["slow"])


class RsiMeanReversionStrategy(Strategy):
    """RSI による平均回帰。

    RSI が oversold 以下になったら買い、overbought 以上になったら売り。
    RSI 計算は Wilder smoothing (lib/indicators.ts の rsi() と同じ実装)。
    """

    name = "rsi_mean_reversion"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        period = int(self.params["period"])
        oversold = float(self.params["oversold"])
        overbought = float(self.params["overbought"])
        close = df["close"].astype(float)

        delta = close.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)

        # Wilder smoothing は初期 SMA + 以降 EWM (alpha = 1/period)
        avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
        rs = avg_gain / avg_loss.replace(0, np.nan)
        rsi = 100 - 100 / (1 + rs)
        # loss == 0 のときは RSI = 100
        rsi = rsi.where(avg_loss > 0, 100.0)

        prev_rsi = rsi.shift(1)
        # oversold 以下に「入った」日に buy、overbought 以上に「入った」日に sell
        cross_below = (prev_rsi > oversold) & (rsi <= oversold)
        cross_above = (prev_rsi < overbought) & (rsi >= overbought)

        signal = pd.Series(0, index=df.index, dtype=int)
        signal[cross_below] = 1
        signal[cross_above] = -1
        return signal

    def required_warmup(self) -> int:
        return int(self.params["period"]) + 1


class MacdCrossStrategy(Strategy):
    """MACD line が signal line を抜けるクロス。

    MACD = EMA(fast) - EMA(slow)、signal = EMA(MACD, signal_period)。
    MACD が signal を下から上に抜けたら買い、上から下に抜けたら売り。
    """

    name = "macd_cross"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        fast_p = int(self.params["fast"])
        slow_p = int(self.params["slow"])
        signal_p = int(self.params["signal"])
        close = df["close"].astype(float)

        ema_fast = close.ewm(span=fast_p, adjust=False, min_periods=fast_p).mean()
        ema_slow = close.ewm(span=slow_p, adjust=False, min_periods=slow_p).mean()
        macd_line = ema_fast - ema_slow
        signal_line = macd_line.ewm(
            span=signal_p, adjust=False, min_periods=signal_p
        ).mean()

        diff = macd_line - signal_line
        prev_diff = diff.shift(1)
        cross_up = (prev_diff <= 0) & (diff > 0)
        cross_down = (prev_diff >= 0) & (diff < 0)

        signal = pd.Series(0, index=df.index, dtype=int)
        signal[cross_up] = 1
        signal[cross_down] = -1
        return signal

    def required_warmup(self) -> int:
        return int(self.params["slow"]) + int(self.params["signal"])


# -------------------------------------------------------------------
# One-Sided Gaussian Filter (Loxx) 移植ヘルパー
# -------------------------------------------------------------------


def _price_source(df: pd.DataFrame, source: str) -> pd.Series:
    """Pine の srcoption 相当。非 Heiken-Ashi の「標準」11 ソースを移植する。

    HA / HAB (Heiken-Ashi Better) 系は loxx ライブラリ依存のため対象外。列が無い場合は
    close にフォールバックする。空白 / アンダースコアは無視して名前照合する
    (例: "Average Median Body" / "avemedbody" / "average_median_body" は同一)。

    avemedbody は loxxexpandedsourcetypes ドキュメントで (Open+Close)/2 と確認済み。
    trendb / trendbext はライブラリ本体が非公開のため、MT4 由来の "Trend biased price"
    (regular / extreme) の定準式を採用している。
    """
    s = source.strip().lower().replace(" ", "").replace("_", "")
    close = df["close"].astype(float)

    def col(name: str) -> pd.Series:
        return df[name].astype(float) if name in df.columns else close

    high, low, open_ = col("high"), col("low"), col("open")
    up, down = close > open_, close < open_

    if s in ("close", ""):
        return close
    if s == "open":
        return open_
    if s == "high":
        return high
    if s == "low":
        return low
    if s == "median":  # hl2
        return (high + low) / 2
    if s == "typical":  # hlc3
        return (high + low + close) / 3
    if s == "weighted":  # hlcc4
        return (high + low + 2 * close) / 4
    if s == "average":  # ohlc4
        return (open_ + high + low + close) / 4
    if s in ("avemedbody", "averagemedianbody"):  # (Open+Close)/2
        return (open_ + close) / 2
    if s in ("trendb", "trendbiased"):  # 陽線: (H+C)/2 / 陰線: (L+C)/2
        return close.where(~up, (high + close) / 2).where(~down, (low + close) / 2)
    if s in ("trendbext", "trendbiasedextreme"):  # 陽線: H / 陰線: L
        return close.where(~up, high).where(~down, low)
    return close


def _osgf_fib_levels(n: int) -> list[int]:
    """フィボナッチ数列 (Pine の _fiblevels)。n=3 → [1, 2, 3]。"""
    levels: list[int] = []
    t1, t2 = 0, 1
    nxt = t1 + t2
    for _ in range(n):
        levels.append(nxt)
        t1, t2 = t2, nxt
        nxt = t1 + t2
    return levels


def _osgf_gaussian(size: int, x: int) -> float:
    """Pine の _gaussian(size, x) = exp(-x^2 * 9 / (size+1)^2)。"""
    return math.exp(-x * x * 9.0 / ((size + 1) * (size + 1)))


def _osgf_weights(smthper: int) -> list[float]:
    """Pine の _smthMA が使う column=smthper のガウシアン加重を返す。

    per = smthper+1 タップ。_gaussout は各 column k に対し gaussian(levels[k], i)
    を並べて正規化するが、_smthMA(level=smthper, ...) が使うのは column=smthper
    だけなので、その 1 列分の重みだけ計算する。返り値 weights[i] は「i 日前」の重み
    (i=0 が当日)。
    """
    per = max(1, smthper + 1)
    levels = _osgf_fib_levels(per)
    size = levels[smthper]  # column=smthper に対応する fib
    weights: list[float] = []
    for i in range(per):
        if i >= size:  # Pine: if (i >= array.get(levels, k)) break
            break
        weights.append(_osgf_gaussian(size, i))
    total = sum(weights)
    return [w / total for w in weights]


def _osgf_gaussian_ma(src: pd.Series, smthper: int) -> pd.Series:
    """Pine の _smthMA: 直近 smthper+1 本の fib-gaussian 加重平均 (out1)。"""
    weights = _osgf_weights(smthper)
    src = src.astype(float)
    out = pd.Series(0.0, index=src.index)
    for i, w in enumerate(weights):
        out = out + w * src.shift(i)
    return out


def _wilder_atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Pine の ta.atr(period) 相当。True Range の Wilder RMA (alpha=1/period)。

    TR = max(H-L, |H-C[1]|, |L-C[1]|)。初日は前日 close が無いので TR = H-L。
    RMA は既存戦略 (RSI の Wilder smoothing) と同じく ewm(alpha=1/period) で近似。
    """
    high = df["high"].astype(float) if "high" in df.columns else df["close"].astype(float)
    low = df["low"].astype(float) if "low" in df.columns else df["close"].astype(float)
    close = df["close"].astype(float)
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    tr.iloc[0] = float(high.iloc[0] - low.iloc[0])  # 初日は H-L
    return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def _two_pole_super_smoother(src: pd.Series, period: int) -> pd.Series:
    """Ehlers 2-pole super smoother (Pine の _twopoless)。

    再帰フィルタなので逐次計算する。先頭 3 本 (bar_index < 3) は src をそのまま入れ、
    NaN の filt[1]/filt[2] は nz() 相当で 0 扱い。out1 先頭の NaN (加重平均の
    warmup 不足分) は入力からスキップし、有効データの通し番号で bar_index を数える。
    """
    a1 = math.exp(-1.414 * math.pi / period)
    b1 = 2 * a1 * math.cos(1.414 * math.pi / period)
    coef2 = b1
    coef3 = -a1 * a1
    coef1 = 1 - coef2 - coef3

    vals = src.to_numpy(dtype=float)
    out = np.full(len(vals), np.nan)
    count = 0  # 有効バーの通し番号 (Pine の bar_index 相当)
    f1 = f2 = math.nan  # filt[1], filt[2]
    for t in range(len(vals)):
        x = vals[t]
        if math.isnan(x):
            continue
        if count < 3:
            f = x
        else:
            p1 = 0.0 if math.isnan(f1) else f1
            p2 = 0.0 if math.isnan(f2) else f2
            f = coef1 * x + coef2 * p1 + coef3 * p2
        out[t] = f
        f2, f1 = f1, f
        count += 1
    return pd.Series(out, index=src.index)


class OneSidedGaussianFilterStrategy(Strategy):
    """One-Sided Gaussian Filter w/ Channels [Loxx] の移植。

    フィボナッチ加重ガウシアン MA (`out1`) を Ehlers 2-pole super smoother で追加平滑化
    した `out` の方向転換をシグナルにする。Pine の
        sig = out[1]
        goLong  = ta.crossover(out, sig)   # out[t] > out[t-1] かつ out[t-1] <= out[t-2]
        goShort = ta.crossunder(out, sig)  # out[t] < out[t-1] かつ out[t-1] >= out[t-2]
    をそのまま再現する (= out が上向きに転じたら buy、下向きに転じたら sell)。

    さらに trend_ma (default 200MA) の傾きでフィルタし、buy は上向き時のみ、sell は
    下向き時のみ発火させる (`trend_filter=False` で無効化)。ATR チャンネル (smax/smin)
    はシグナルに関与しない可視化要素なので移植対象外。

    params (キー名は Pine の入力変数名に一致させている):
      smthper       : Pine `smthper` "Guassian Levels Depth" (default 10)。タップ数 = smthper+1
      extrasmthper  : Pine `extrasmthper` "Extra Smoothing (2-Pole ...) Period" (default 10)
      atrper        : Pine `atrper` "ATR Period" (default 21)。チャンネル用 (シグナル非関与)
      mult          : Pine `mult` "ATR Multiplier / ATR乗数" (default 0.628)。upper/lower = out ± atr*mult
      srcoption     : Pine `srcoption` "Source / ソース" (default close)。非 HA の標準 11 種:
                      close/open/high/low/median/typical/weighted/average/
                      avemedbody/trendb/trendbext。HA/HAB は未対応
                      (Pine `smthtype` "Heiken-Ashi Better Smoothing" は HAB source 専用のため未移植)
      trend_ma      : [独自追加/Pine 外] トレンドフィルタ SMA 期間 (default 200)
      trend_slope   : [独自追加/Pine 外] 傾き判定の lookback (default 1)。ma > ma[trend_slope] で上向き
      trend_filter  : [独自追加/Pine 外] トレンドフィルタ有効化 (default True)
    """

    name = "osgf"

    def _osgf_line(self, df: pd.DataFrame) -> pd.Series:
        """Pine の out (fib-gaussian MA → 2-pole Ehlers super smoother)。"""
        src = _price_source(df, str(self.params.get("srcoption", "close")))
        out1 = _osgf_gaussian_ma(src, int(self.params["smthper"]))
        return _two_pole_super_smoother(out1, int(self.params["extrasmthper"]))

    def channel(self, df: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
        """Pine の可視化チャンネル。(out, atr, upper=smax, lower=smin) を返す。

        upper = out + atr*mult、lower = out - atr*mult。goLong/goShort には関与しない
        (Pine と同じ)。通知にストップ参考値として載せる用途。
        """
        out = self._osgf_line(df)
        atr = _wilder_atr(df, int(self.params["atrper"]))
        mult = float(self.params["mult"])
        return out, atr, out + atr * mult, out - atr * mult

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        out = self._osgf_line(df)
        prev = out.shift(1)
        prev2 = out.shift(2)
        go_long = (out > prev) & (prev <= prev2)
        go_short = (out < prev) & (prev >= prev2)

        if bool(self.params["trend_filter"]):
            close = df["close"].astype(float)
            ma_p = int(self.params["trend_ma"])
            ma = close.rolling(ma_p, min_periods=ma_p).mean()
            ma_prev = ma.shift(int(self.params["trend_slope"]))
            go_long = go_long & (ma > ma_prev)
            go_short = go_short & (ma < ma_prev)

        signal = pd.Series(0, index=df.index, dtype=int)
        signal[go_long] = 1
        signal[go_short] = -1
        return signal

    def required_warmup(self) -> int:
        base = max(
            int(self.params["smthper"]) + int(self.params["extrasmthper"]) + 3,
            int(self.params["atrper"]) + 1,
        )
        if bool(self.params["trend_filter"]):
            return max(base, int(self.params["trend_ma"]) + int(self.params["trend_slope"]))
        return base


# -------------------------------------------------------------------
# Registry
# -------------------------------------------------------------------

DEFAULT_PARAMS: dict[str, dict[str, Any]] = {
    "sma_cross": {"fast": 25, "slow": 75},
    "rsi_mean_reversion": {"period": 14, "oversold": 30, "overbought": 70},
    "macd_cross": {"fast": 12, "slow": 26, "signal": 9},
    "osgf": {
        "smthper": 10,
        "extrasmthper": 10,
        "atrper": 21,
        "mult": 0.628,
        "srcoption": "close",
        "trend_ma": 200,
        "trend_slope": 1,
        "trend_filter": True,
    },
}

STRATEGIES: dict[str, type[Strategy]] = {
    "sma_cross": SmaCrossStrategy,
    "rsi_mean_reversion": RsiMeanReversionStrategy,
    "macd_cross": MacdCrossStrategy,
    "osgf": OneSidedGaussianFilterStrategy,
}


def make_strategy(name: str, params: dict[str, Any]) -> Strategy:
    if name not in STRATEGIES:
        raise ValueError(
            f"unknown strategy: {name}. available: {list(STRATEGIES.keys())}"
        )
    return STRATEGIES[name](params)
