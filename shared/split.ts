/**
 * 分攤演算法。**前後端共用同一份** —— 表單的即時試算與 server 寫入時的計算
 * 必須逐分錢一致,否則使用者會看到「畫面顯示合計正確,送出卻被退回」。
 *
 * 兩個函式都保證 sum(結果) === amountMinor(不會因為四捨五入漏錢或生錢),
 * 並且對相同輸入永遠給出相同拆分(依 memberId 排序),方便稽核與測試。
 */
import type { SplitMode } from './types.ts';
export type { SplitMode };

/**
 * 均分,並把除不盡的餘數用「最大餘數法」分配,確保 sum(shares) === amountMinor。
 * 依 memberId 排序讓結果可重現(同樣輸入永遠得到同樣拆分,方便稽核與測試)。
 */
export function splitEqually(amountMinor: number, memberIds: string[]): Map<string, number> {
  const ids = [...memberIds].sort();
  const n = ids.length;
  const out = new Map<string, number>();
  if (n === 0) return out;

  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);
  const base = Math.floor(abs / n);
  let remainder = abs - base * n;      // 0 <= remainder < n

  for (const id of ids) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    out.set(id, sign * (base + extra));
  }
  return out;
}

/** 按份數/比例分攤(shares 可以是份數 2:1:1,也可以是百分比 50/25/25)。 */
export function splitByShares(amountMinor: number, shares: Record<string, number>): Map<string, number> {
  const ids = Object.keys(shares).sort();
  const total = ids.reduce((s, id) => s + shares[id], 0);
  const out = new Map<string, number>();
  if (total <= 0) return out;

  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);

  // 先取整數部分,再把餘數依小數部分由大到小補給前幾位(最大餘數法)。
  const exact = ids.map((id) => ({ id, v: (abs * shares[id]) / total }));
  const floored = exact.map((e) => ({ ...e, f: Math.floor(e.v), frac: e.v - Math.floor(e.v) }));
  let remainder = abs - floored.reduce((s, e) => s + e.f, 0);

  floored.sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1));
  for (const e of floored) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    out.set(e.id, sign * (e.f + extra));
  }
  return out;
}

