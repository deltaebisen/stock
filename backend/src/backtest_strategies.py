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
# Registry
# -------------------------------------------------------------------

DEFAULT_PARAMS: dict[str, dict[str, Any]] = {
    "sma_cross": {"fast": 25, "slow": 75},
    "rsi_mean_reversion": {"period": 14, "oversold": 30, "overbought": 70},
    "macd_cross": {"fast": 12, "slow": 26, "signal": 9},
}

STRATEGIES: dict[str, type[Strategy]] = {
    "sma_cross": SmaCrossStrategy,
    "rsi_mean_reversion": RsiMeanReversionStrategy,
    "macd_cross": MacdCrossStrategy,
}


def make_strategy(name: str, params: dict[str, Any]) -> Strategy:
    if name not in STRATEGIES:
        raise ValueError(
            f"unknown strategy: {name}. available: {list(STRATEGIES.keys())}"
        )
    return STRATEGIES[name](params)
