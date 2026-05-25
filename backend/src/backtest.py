"""バックテストエンジン + メトリクス + DB 保存 + CLI。

実行例:
  python -m src.backtest --strategy sma_cross --params fast=25,slow=75 \\
      --universe single:1301 --from 2021-01-01 --to 2025-12-31

  python -m src.backtest --strategy rsi_mean_reversion --params period=14,oversold=30,overbought=70 \\
      --universe 'scale:TOPIX Large 70' --from 2020-01-01 --to 2025-12-31

実装方針:
  - event-driven、日次ループ。当日 close で約定 (簡略)
  - long-only、等額配分 (新規エントリー発生日に残現金を新規組数で等分)
  - 既存ポジションへの追加買い無し、空売り無し
  - commission_bps は片道 (default 10bps = 0.1%)、スリッページの近似も兼ねる
  - 結果は backtest_runs / backtest_trades / backtest_equity に永続化
  - 100 株単位等の売買単位制約は無視 (1 株単位)

universe_spec の書式:
  - "all"                          : listed_info の全銘柄
  - "scale:TOPIX Large 70"         : scale_category 完全一致
  - "codes:7203,9984,1301"         : カンマ区切り explicit list
  - "single:1301"                  : 1 銘柄ショートカット
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import text

from .backtest_strategies import STRATEGIES, make_strategy
from .db import get_engine


# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------


@dataclass
class BacktestConfig:
    strategy: str
    params: dict[str, Any]
    universe_spec: str
    from_date: date
    to_date: date
    initial_capital: float = 1_000_000.0
    commission_bps: int = 10
    name: str | None = None
    # resolve_universe 後に埋まる
    universe_codes: list[str] = field(default_factory=list)


# -------------------------------------------------------------------
# Universe 解決
# -------------------------------------------------------------------


def resolve_universe(engine, spec: str) -> list[str]:
    spec = spec.strip()
    if spec == "all":
        sql = "SELECT code FROM listed_info ORDER BY code"
        with engine.connect() as conn:
            rows = conn.execute(text(sql)).fetchall()
        return [r[0] for r in rows]
    if spec.startswith("scale:"):
        scale = spec[len("scale:") :]
        sql = (
            "SELECT code FROM listed_info "
            "WHERE scale_category = :s ORDER BY code"
        )
        with engine.connect() as conn:
            rows = conn.execute(text(sql), {"s": scale}).fetchall()
        return [r[0] for r in rows]
    if spec.startswith("codes:"):
        return [c.strip() for c in spec[len("codes:") :].split(",") if c.strip()]
    if spec.startswith("single:"):
        return [spec[len("single:") :].strip()]
    raise ValueError(
        f"unknown universe spec: {spec!r}. "
        f"use 'all' / 'scale:<name>' / 'codes:7203,9984,...' / 'single:7203'"
    )


# -------------------------------------------------------------------
# データロード
# -------------------------------------------------------------------


def load_quotes(
    engine,
    codes: list[str],
    from_date: date,
    to_date: date,
) -> dict[str, pd.DataFrame]:
    """銘柄ごとに DatetimeIndex (DATE) + open/high/low/close/volume の DataFrame を返す。

    adjustment_* (split/併合調整済み) を使う。adjustment_close が NULL の行は除外。
    universe 数 × 期間で 1 クエリで一括取得 → code で groupby で銘柄ごとに切り分け。
    """
    if not codes:
        return {}

    # IN ( ... ) を inline 展開 (sqlalchemy の expanding bindparam でも良いが pandas との
    # 相性で placeholder 文字数だけ多いほうがシンプル。銘柄数は最大数千なので問題なし)
    placeholders = ", ".join(f":c{i}" for i in range(len(codes)))
    params: dict[str, Any] = {f"c{i}": c for i, c in enumerate(codes)}
    params["from_date"] = from_date
    params["to_date"] = to_date

    sql = (
        "SELECT code, trade_date, "
        "  adjustment_open AS open, adjustment_high AS high, "
        "  adjustment_low AS low, adjustment_close AS close, "
        "  adjustment_volume AS volume "
        "FROM daily_quotes "
        f"WHERE code IN ({placeholders}) "
        "  AND trade_date BETWEEN :from_date AND :to_date "
        "  AND adjustment_close IS NOT NULL "
        "ORDER BY code, trade_date"
    )

    with engine.connect() as conn:
        df = pd.read_sql(text(sql), conn, params=params)

    if df.empty:
        return {}

    df["trade_date"] = pd.to_datetime(df["trade_date"])
    out: dict[str, pd.DataFrame] = {}
    for code, sub in df.groupby("code", sort=False):
        sub = sub.set_index("trade_date").sort_index()
        out[str(code)] = sub[["open", "high", "low", "close", "volume"]].astype(float)
    return out


# -------------------------------------------------------------------
# Engine
# -------------------------------------------------------------------


@dataclass
class OpenPosition:
    entry_date: pd.Timestamp
    entry_price: float
    shares: int
    entry_commission: float  # 既に cash から差し引き済み


@dataclass
class ClosedTrade:
    code: str
    entry_date: pd.Timestamp
    entry_price: float
    exit_date: pd.Timestamp
    exit_price: float
    shares: int
    commission: float  # 往復合計
    pnl: float
    pnl_pct: float
    exit_reason: str


@dataclass
class EquityPoint:
    trade_date: pd.Timestamp
    equity: float
    cash: float
    position_count: int
    drawdown: float


def run_backtest(
    config: BacktestConfig,
    data: dict[str, pd.DataFrame],
    signals: dict[str, pd.Series],
) -> tuple[list[ClosedTrade], list[EquityPoint]]:
    """データとシグナル所与で event-driven バックテストを走らせる。

    全日付の union を走査して、各日:
      1. 当日 close を mark-to-market 用に取得
      2. 既存ポジションへの sell signal を処理 (現金化)
      3. 新規 buy signal を等額配分で entry
      4. equity 記録
    """
    initial_capital = float(config.initial_capital)
    bps = float(config.commission_bps) / 10000.0  # 片道 (0.001 = 0.1%)

    # 全銘柄の全日付 union (sorted)
    all_dates_set: set[pd.Timestamp] = set()
    for df in data.values():
        all_dates_set.update(df.index)
    all_dates = sorted(all_dates_set)

    positions: dict[str, OpenPosition] = {}
    cash = initial_capital
    trades: list[ClosedTrade] = []
    equity_curve: list[EquityPoint] = []
    running_max = initial_capital

    for d in all_dates:
        # ---- 1. exit signal の処理 ----
        for code in list(positions.keys()):
            sig_series = signals.get(code)
            if sig_series is None or d not in sig_series.index:
                continue
            if sig_series.loc[d] != -1:
                continue
            df = data[code]
            if d not in df.index:
                continue
            exit_price = float(df.loc[d, "close"])
            pos = positions[code]
            gross = pos.shares * exit_price
            exit_commission = gross * bps
            cash += gross - exit_commission
            commission_total = pos.entry_commission + exit_commission
            pnl = (
                (exit_price - pos.entry_price) * pos.shares - commission_total
            )
            pnl_pct = pnl / (pos.entry_price * pos.shares)
            trades.append(
                ClosedTrade(
                    code=code,
                    entry_date=pos.entry_date,
                    entry_price=pos.entry_price,
                    exit_date=d,
                    exit_price=exit_price,
                    shares=pos.shares,
                    commission=commission_total,
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                    exit_reason="signal",
                )
            )
            del positions[code]

        # ---- 2. entry signal の処理 (等額配分) ----
        entries_today: list[tuple[str, float]] = []  # (code, close_price)
        for code, sig_series in signals.items():
            if code in positions:
                continue
            if d not in sig_series.index:
                continue
            if sig_series.loc[d] != 1:
                continue
            df = data[code]
            if d not in df.index:
                continue
            price = float(df.loc[d, "close"])
            if price <= 0:
                continue
            entries_today.append((code, price))

        if entries_today and cash > 0:
            per_position = cash / len(entries_today)
            for code, price in entries_today:
                # 手数料込みでフィットする株数を計算
                cost_per_share = price * (1 + bps)
                shares = int(per_position / cost_per_share)
                if shares <= 0:
                    continue
                gross = shares * price
                entry_commission = gross * bps
                cost = gross + entry_commission
                if cost > cash:
                    continue  # 端数で超えたら skip
                cash -= cost
                positions[code] = OpenPosition(
                    entry_date=d,
                    entry_price=price,
                    shares=shares,
                    entry_commission=entry_commission,
                )

        # ---- 3. 日末 equity 集計 ----
        equity = cash
        for code, pos in positions.items():
            df = data[code]
            if d in df.index:
                equity += pos.shares * float(df.loc[d, "close"])
            else:
                # その日に値が無ければ entry 価格で評価 (上場廃止前後等のレアケース)
                equity += pos.shares * pos.entry_price

        running_max = max(running_max, equity)
        drawdown = 1.0 - equity / running_max if running_max > 0 else 0.0
        equity_curve.append(
            EquityPoint(
                trade_date=d,
                equity=equity,
                cash=cash,
                position_count=len(positions),
                drawdown=drawdown,
            )
        )

    # ---- 4. 残存ポジションを最終日 close で強制決済 ----
    if all_dates:
        last_d = all_dates[-1]
        for code in list(positions.keys()):
            pos = positions[code]
            df = data[code]
            # その日に値が無ければ最終に近い日を採用
            available = df.index[df.index <= last_d]
            if len(available) == 0:
                continue
            exit_d = available[-1]
            exit_price = float(df.loc[exit_d, "close"])
            gross = pos.shares * exit_price
            exit_commission = gross * bps
            commission_total = pos.entry_commission + exit_commission
            pnl = (exit_price - pos.entry_price) * pos.shares - commission_total
            pnl_pct = pnl / (pos.entry_price * pos.shares)
            trades.append(
                ClosedTrade(
                    code=code,
                    entry_date=pos.entry_date,
                    entry_price=pos.entry_price,
                    exit_date=exit_d,
                    exit_price=exit_price,
                    shares=pos.shares,
                    commission=commission_total,
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                    exit_reason="end_of_test",
                )
            )

    return trades, equity_curve


# -------------------------------------------------------------------
# Metrics
# -------------------------------------------------------------------


def compute_metrics(
    equity_curve: list[EquityPoint],
    trades: list[ClosedTrade],
    initial_capital: float,
) -> dict[str, Any]:
    if not equity_curve:
        return {
            "final_equity": initial_capital,
            "total_return": 0.0,
            "cagr": 0.0,
            "max_drawdown": 0.0,
            "sharpe": 0.0,
            "win_rate": 0.0,
            "num_trades": 0,
            "num_bars": 0,
        }

    final_equity = equity_curve[-1].equity
    total_return = final_equity / initial_capital - 1.0
    num_bars = len(equity_curve)

    # CAGR (252 営業日 / 年 換算)
    years = num_bars / 252.0
    cagr = (
        (final_equity / initial_capital) ** (1.0 / years) - 1.0
        if years > 0 and final_equity > 0
        else 0.0
    )

    # max drawdown は equity_curve 内の running max ベース
    max_dd = max((p.drawdown for p in equity_curve), default=0.0)

    # Sharpe (risk-free=0, 年率化)
    equities = np.array([p.equity for p in equity_curve], dtype=float)
    if len(equities) >= 2:
        daily_ret = np.diff(equities) / equities[:-1]
        if daily_ret.std(ddof=1) > 0:
            sharpe = (
                daily_ret.mean() / daily_ret.std(ddof=1) * np.sqrt(252)
            )
        else:
            sharpe = 0.0
    else:
        sharpe = 0.0

    # win rate (closed_trades のうち pnl > 0)
    wins = sum(1 for t in trades if t.pnl > 0)
    win_rate = wins / len(trades) if trades else 0.0

    return {
        "final_equity": float(final_equity),
        "total_return": float(total_return),
        "cagr": float(cagr),
        "max_drawdown": float(max_dd),
        "sharpe": float(sharpe),
        "win_rate": float(win_rate),
        "num_trades": len(trades),
        "num_bars": num_bars,
    }


# -------------------------------------------------------------------
# DB 永続化
# -------------------------------------------------------------------


def insert_run_start(engine, config: BacktestConfig) -> int:
    sql = text(
        "INSERT INTO backtest_runs "
        "(name, strategy, params, universe_spec, universe_codes, "
        " from_date, to_date, initial_capital, commission_bps, status) "
        "VALUES "
        "(:name, :strategy, :params, :universe_spec, :universe_codes, "
        " :from_date, :to_date, :initial_capital, :commission_bps, 'running')"
    )
    with engine.begin() as conn:
        result = conn.execute(
            sql,
            {
                "name": config.name,
                "strategy": config.strategy,
                "params": json.dumps(config.params),
                "universe_spec": config.universe_spec,
                "universe_codes": json.dumps(config.universe_codes),
                "from_date": config.from_date,
                "to_date": config.to_date,
                "initial_capital": config.initial_capital,
                "commission_bps": config.commission_bps,
            },
        )
        return int(result.lastrowid)


def finish_run_success(
    engine,
    run_id: int,
    metrics: dict[str, Any],
    trades: list[ClosedTrade],
    equity_curve: list[EquityPoint],
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE backtest_runs SET "
                "  final_equity = :final_equity, "
                "  total_return = :total_return, "
                "  cagr = :cagr, "
                "  max_drawdown = :max_drawdown, "
                "  sharpe = :sharpe, "
                "  win_rate = :win_rate, "
                "  num_trades = :num_trades, "
                "  num_bars = :num_bars, "
                "  status = 'success', "
                "  finished_at = NOW() "
                "WHERE id = :id"
            ),
            {**metrics, "id": run_id},
        )

        if trades:
            trade_rows = [
                {
                    "run_id": run_id,
                    "code": t.code,
                    "side": "long",
                    "entry_date": t.entry_date.date()
                    if isinstance(t.entry_date, pd.Timestamp)
                    else t.entry_date,
                    "entry_price": float(t.entry_price),
                    "exit_date": t.exit_date.date()
                    if isinstance(t.exit_date, pd.Timestamp)
                    else t.exit_date,
                    "exit_price": float(t.exit_price),
                    "shares": int(t.shares),
                    "commission": float(t.commission),
                    "pnl": float(t.pnl),
                    "pnl_pct": float(t.pnl_pct),
                    "exit_reason": t.exit_reason,
                }
                for t in trades
            ]
            conn.execute(
                text(
                    "INSERT INTO backtest_trades "
                    "(run_id, code, side, entry_date, entry_price, "
                    " exit_date, exit_price, shares, commission, pnl, pnl_pct, exit_reason) "
                    "VALUES "
                    "(:run_id, :code, :side, :entry_date, :entry_price, "
                    " :exit_date, :exit_price, :shares, :commission, :pnl, :pnl_pct, :exit_reason)"
                ),
                trade_rows,
            )

        if equity_curve:
            # 大きいので 1000 件ずつ
            eq_rows = [
                {
                    "run_id": run_id,
                    "trade_date": p.trade_date.date()
                    if isinstance(p.trade_date, pd.Timestamp)
                    else p.trade_date,
                    "equity": float(p.equity),
                    "cash": float(p.cash),
                    "position_count": int(p.position_count),
                    "drawdown": float(p.drawdown),
                }
                for p in equity_curve
            ]
            insert_eq = text(
                "INSERT INTO backtest_equity "
                "(run_id, trade_date, equity, cash, position_count, drawdown) "
                "VALUES (:run_id, :trade_date, :equity, :cash, :position_count, :drawdown)"
            )
            BATCH = 1000
            for i in range(0, len(eq_rows), BATCH):
                conn.execute(insert_eq, eq_rows[i : i + BATCH])


def finish_run_error(engine, run_id: int, message: str) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE backtest_runs SET status = 'error', "
                "  error_message = :msg, finished_at = NOW() WHERE id = :id"
            ),
            {"id": run_id, "msg": message[:1000]},
        )


# -------------------------------------------------------------------
# 全体オーケストレーション
# -------------------------------------------------------------------


def run(config: BacktestConfig) -> int:
    """設定どおりにバックテストを実行して run_id を返す。"""
    engine = get_engine()

    # universe 解決
    codes = resolve_universe(engine, config.universe_spec)
    if not codes:
        raise RuntimeError(f"universe spec '{config.universe_spec}' で 0 銘柄")
    config.universe_codes = codes
    print(f"[backtest] universe={config.universe_spec} → {len(codes)} 銘柄")

    # run 行を先に作成 (失敗時の追跡用)
    run_id = insert_run_start(engine, config)
    print(f"[backtest] run_id={run_id} status=running")

    try:
        # データロード
        print(
            f"[backtest] daily_quotes load: codes={len(codes)} "
            f"period={config.from_date} 〜 {config.to_date}"
        )
        data = load_quotes(engine, codes, config.from_date, config.to_date)
        if not data:
            raise RuntimeError("該当銘柄の daily_quotes が空")
        print(
            f"[backtest] loaded {len(data)} 銘柄, "
            f"total {sum(len(df) for df in data.values())} bars"
        )

        # シグナル生成
        strategy = make_strategy(config.strategy, config.params)
        signals: dict[str, pd.Series] = {}
        for code, df in data.items():
            signals[code] = strategy.generate_signals(df)
        print(f"[backtest] signals generated for {len(signals)} 銘柄")

        # event-driven 実行
        trades, equity_curve = run_backtest(config, data, signals)
        print(
            f"[backtest] simulation done: {len(trades)} trades, "
            f"{len(equity_curve)} equity points"
        )

        # メトリクス計算
        metrics = compute_metrics(equity_curve, trades, config.initial_capital)
        print(
            f"[backtest] metrics: "
            f"final={metrics['final_equity']:,.0f} "
            f"return={metrics['total_return']*100:.2f}% "
            f"CAGR={metrics['cagr']*100:.2f}% "
            f"DD={metrics['max_drawdown']*100:.2f}% "
            f"Sharpe={metrics['sharpe']:.2f} "
            f"win={metrics['win_rate']*100:.1f}% "
            f"trades={metrics['num_trades']}"
        )

        # 永続化
        finish_run_success(engine, run_id, metrics, trades, equity_curve)
        print(f"[backtest] run_id={run_id} status=success (persisted)")
        return run_id

    except Exception as e:
        finish_run_error(engine, run_id, f"{type(e).__name__}: {e}")
        print(f"[backtest][ERROR] run_id={run_id}: {e}")
        raise


# -------------------------------------------------------------------
# CLI
# -------------------------------------------------------------------


def _parse_params(s: str) -> dict[str, Any]:
    """'fast=25,slow=75' → {'fast': 25.0, 'slow': 75.0}

    値は数値変換を試みて成功すれば float / int、失敗すれば str のまま。
    """
    if not s:
        return {}
    out: dict[str, Any] = {}
    for pair in s.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            raise ValueError(f"invalid params item (no '='): {pair!r}")
        k, v = pair.split("=", 1)
        k = k.strip()
        v = v.strip()
        # int → float → str の順で試す
        try:
            iv = int(v)
            out[k] = iv
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


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="backtest",
        description="バックテスト実行 (結果は backtest_runs / backtest_trades / backtest_equity に保存)",
    )
    p.add_argument(
        "--strategy",
        required=True,
        choices=sorted(STRATEGIES.keys()),
        help="使用する戦略",
    )
    p.add_argument(
        "--params",
        default="",
        help="戦略パラメータ。'key=val,key=val' 形式。空ならデフォルト",
    )
    p.add_argument(
        "--universe",
        required=True,
        help="universe spec。'all' / 'scale:TOPIX Large 70' / 'codes:7203,9984' / 'single:1301'",
    )
    p.add_argument("--from", dest="from_date", required=True, help="YYYY-MM-DD")
    p.add_argument("--to", dest="to_date", required=True, help="YYYY-MM-DD")
    p.add_argument(
        "--capital", type=float, default=1_000_000.0, help="初期資金 (default 1,000,000)"
    )
    p.add_argument(
        "--commission",
        type=int,
        default=10,
        help="片道手数料 (basis points、default 10 = 0.10%%)",
    )
    p.add_argument("--name", default=None, help="任意ラベル (DB の name 列に保存)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        config = BacktestConfig(
            strategy=args.strategy,
            params=_parse_params(args.params),
            universe_spec=args.universe,
            from_date=datetime.strptime(args.from_date, "%Y-%m-%d").date(),
            to_date=datetime.strptime(args.to_date, "%Y-%m-%d").date(),
            initial_capital=args.capital,
            commission_bps=args.commission,
            name=args.name,
        )
        run(config)
        return 0
    except Exception as e:
        print(f"[backtest][FATAL] {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
