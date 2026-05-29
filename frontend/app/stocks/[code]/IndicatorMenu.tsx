"use client";

import { useRef, useState, useEffect } from "react";
import {
  type IndicatorInstance,
  type IndicatorType,
  INDICATOR_LABEL,
  describeIndicator,
  makeIndicator,
} from "@/lib/indicators";

const AVAILABLE_TYPES: IndicatorType[] = ["SMA", "EMA", "BB", "MACD", "RSI"];

type Props = {
  indicators: IndicatorInstance[];
  setIndicators: (next: IndicatorInstance[]) => void;
  /** id → 各 line の直近値配列 (chip 内に出す) */
  latestValues: Map<string, (number | null)[]>;
};

export default function IndicatorMenu({
  indicators,
  setIndicators,
  latestValues,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [settingsForId, setSettingsForId] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement | null>(null);

  // dropdown 外クリックで閉じる
  useEffect(() => {
    if (!addOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [addOpen]);

  const addIndicator = (type: IndicatorType) => {
    setIndicators([...indicators, makeIndicator(type)]);
    setAddOpen(false);
  };

  const removeIndicator = (id: string) => {
    setIndicators(indicators.filter((i) => i.id !== id));
    if (settingsForId === id) setSettingsForId(null);
  };

  const updateIndicator = (next: IndicatorInstance) => {
    setIndicators(indicators.map((i) => (i.id === next.id ? next : i)));
  };

  return (
    <div className="indicator-menu">
      <div className="add-wrap" ref={addRef}>
        <button
          type="button"
          className="add-btn"
          onClick={() => setAddOpen((v) => !v)}
        >
          + Indicator
        </button>
        {addOpen && (
          <div className="add-dropdown">
            {AVAILABLE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="add-item"
                onClick={() => addIndicator(t)}
              >
                {INDICATOR_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="chip-row">
        {indicators.map((ind) => (
          <IndicatorChip
            key={ind.id}
            ind={ind}
            latest={latestValues.get(ind.id) ?? []}
            onRemove={() => removeIndicator(ind.id)}
            onOpenSettings={() =>
              setSettingsForId(settingsForId === ind.id ? null : ind.id)
            }
            settingsOpen={settingsForId === ind.id}
            onUpdate={updateIndicator}
            onCloseSettings={() => setSettingsForId(null)}
          />
        ))}
      </div>
    </div>
  );
}

function fmtNum(v: number | null, digits = 2): string {
  if (v === null || Number.isNaN(v)) return "-";
  if (Math.abs(v) >= 1000) {
    return v.toLocaleString("ja-JP", { maximumFractionDigits: 0 });
  }
  return v.toFixed(digits);
}

function IndicatorChip({
  ind,
  latest,
  onRemove,
  onOpenSettings,
  settingsOpen,
  onUpdate,
  onCloseSettings,
}: {
  ind: IndicatorInstance;
  latest: (number | null)[];
  onRemove: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onUpdate: (next: IndicatorInstance) => void;
  onCloseSettings: () => void;
}) {
  const valuesText = latest.map((v) => fmtNum(v)).join(" / ");
  // overlay 系の代表色 (chip 左の縦バー)
  const repColor = ind.type === "MACD" ? ind.lineColor : ind.color;

  return (
    <div className="chip-wrap">
      <div className="chip">
        <span className="chip-color" style={{ background: repColor }} />
        <span className="chip-name mono">{describeIndicator(ind)}</span>
        {valuesText && <span className="chip-value mono">{valuesText}</span>}
        <button
          type="button"
          className="chip-btn"
          aria-label="settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
        <button
          type="button"
          className="chip-btn"
          aria-label="remove"
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {settingsOpen && (
        <IndicatorSettings
          ind={ind}
          onUpdate={onUpdate}
          onClose={onCloseSettings}
        />
      )}
    </div>
  );
}

function IndicatorSettings({
  ind,
  onUpdate,
  onClose,
}: {
  ind: IndicatorInstance;
  onUpdate: (next: IndicatorInstance) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);

  // 外クリックで閉じる
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div className="settings-pop" ref={popRef}>
      {ind.type === "SMA" || ind.type === "EMA" ? (
        <>
          <NumField
            label="Period"
            value={ind.period}
            min={1}
            max={500}
            onChange={(v) => onUpdate({ ...ind, period: v })}
          />
          <ColorField
            value={ind.color}
            onChange={(c) => onUpdate({ ...ind, color: c })}
          />
        </>
      ) : ind.type === "BB" ? (
        <>
          <NumField
            label="Period"
            value={ind.period}
            min={2}
            max={500}
            onChange={(v) => onUpdate({ ...ind, period: v })}
          />
          <NumField
            label="StdDev"
            value={ind.stddev}
            min={0.1}
            max={10}
            step={0.1}
            onChange={(v) => onUpdate({ ...ind, stddev: v })}
          />
          <ColorField
            value={ind.color}
            onChange={(c) => onUpdate({ ...ind, color: c })}
          />
        </>
      ) : ind.type === "MACD" ? (
        <>
          <NumField
            label="Fast"
            value={ind.fast}
            min={1}
            max={200}
            onChange={(v) => onUpdate({ ...ind, fast: v })}
          />
          <NumField
            label="Slow"
            value={ind.slow}
            min={1}
            max={500}
            onChange={(v) => onUpdate({ ...ind, slow: v })}
          />
          <NumField
            label="Signal"
            value={ind.signal}
            min={1}
            max={200}
            onChange={(v) => onUpdate({ ...ind, signal: v })}
          />
          <ColorField
            label="MACD"
            value={ind.lineColor}
            onChange={(c) => onUpdate({ ...ind, lineColor: c })}
          />
          <ColorField
            label="Signal"
            value={ind.signalColor}
            onChange={(c) => onUpdate({ ...ind, signalColor: c })}
          />
        </>
      ) : ind.type === "RSI" ? (
        <>
          <NumField
            label="Period"
            value={ind.period}
            min={2}
            max={200}
            onChange={(v) => onUpdate({ ...ind, period: v })}
          />
          <ColorField
            value={ind.color}
            onChange={(c) => onUpdate({ ...ind, color: c })}
          />
        </>
      ) : null}
    </div>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </label>
  );
}

function ColorField({
  label = "Color",
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
