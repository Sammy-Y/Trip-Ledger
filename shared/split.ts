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

/**
 * 記帳表單的分攤草稿 —— 三種模式各自獨立保存,切模式回來不會被清掉。
 * null 代表「還沒填」(和「填了 0」是兩件事)。
 */
export interface SplitDraft {
  mode: SplitMode;
  /** 均分:參與的成員 id */
  members: string[];
  /** 按份數:成員 id -> 份數 */
  shares: Record<string, number | null>;
  /** 指定金額:成員 id -> 人類單位金額 */
  amounts: Record<string, number | null>;
}

/**
 * 算出「每個人分攤多少」(最小單位)。
 *
 * ⚠️ 這個函式存在的原因是一個真實的 bug:
 *
 * 個人花費(kind = 'personal')不經過分攤編輯器,表單原本把 draft 設成
 * `{ mode:'exact', amounts: { [owner]: null } }` —— 金額是 null,因為
 * 使用者根本沒在分攤欄填過東西。而 exact 模式會濾掉 null,
 * 於是 preview 是空的 `{}`,驗證就判定「請選擇分攤的人」,
 * **送出鈕被永久鎖住,個人花費完全記不起來**。
 *
 * 修法是讓「個人花費的分攤 = 全額算給付款人」成為一個明確的規則,
 * 而不是靠 draft 裡剛好有沒有值。抽到 shared/ 是為了讓它能被測 ——
 * 原本這段邏輯埋在 .vue 的 computed 裡,任何測試都碰不到,
 * 所以那個 bug 在 56 個 API 測試全綠的情況下活了下來。
 *
 * @param toMinorFn 把人類單位換成最小單位(呼叫端帶入 money.ts 的 toMinor)
 */
export function previewShares(input: {
  kind: 'shared' | 'personal';
  amountMinor: number;
  draft: SplitDraft;
  /** 個人花費的擁有者(= 付款人) */
  ownerId?: string;
  toMinorFn: (amount: number) => number;
}): Record<string, number> {
  const { kind, amountMinor, draft, ownerId, toMinorFn } = input;
  if (!amountMinor) return {};

  // 個人花費:全額算在自己頭上,不看 draft。
  if (kind === 'personal') return ownerId ? { [ownerId]: amountMinor } : {};

  if (draft.mode === 'equal') {
    return draft.members.length
      ? Object.fromEntries(splitEqually(amountMinor, draft.members))
      : {};
  }
  if (draft.mode === 'shares') {
    const s: Record<string, number> = {};
    for (const [k, v] of Object.entries(draft.shares)) if (v && v > 0) s[k] = v;
    return Object.keys(s).length ? Object.fromEntries(splitByShares(amountMinor, s)) : {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(draft.amounts)) {
    if (v != null && v !== 0) out[k] = toMinorFn(v);
  }
  return out;
}

/** 按份數/比例分攤(shares 可以是份數 2:1:1,也可以是百分比 50/25/25)。 */
export function splitByShares(amountMinor: number, shares: Record<string, number>): Map<string, number> {
  const ids = Object.keys(shares).sort();
  // ids 來自 Object.keys(shares),所以每個 key 一定查得到 —— ! 是安全的。
  const total = ids.reduce((s, id) => s + shares[id]!, 0);
  const out = new Map<string, number>();
  if (total <= 0) return out;

  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);

  // 先取整數部分,再把餘數依小數部分由大到小補給前幾位(最大餘數法)。
  const exact = ids.map((id) => ({ id, v: (abs * shares[id]!) / total }));
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

