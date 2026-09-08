/** API 回應的形狀。UI 只能依賴這裡宣告的欄位。 */
export type Kind = 'shared' | 'personal';
export type PaymentMethod = 'cash' | 'card';
export type SplitMode = 'equal' | 'shares' | 'exact';

export interface Trip {
  id: string; name: string; base_currency: string;
  start_date: string | null; end_date: string | null;
}
/** is_pot = 1 是公費(不是人,是持有現金的實體)。一趟旅程最多一個。 */
export interface Member { id: string; name: string; is_pot: number; }

export interface Expense {
  id: string; kind: Kind; description: string; category: string | null;
  currency: string; amount_minor: number;
  payment_method: PaymentMethod;
  fx_rate: number | null; fx_rate_date: string | null; fx_rate_source: string | null;
  fx_rate_override: number | null; fx_markup_pct: number;
  spent_at: string; note: string | null; created_at: string;
  /**
   * 已經在哪一次結算回合被列入。null = 還沒結算。
   *
   * ⚠️ 這是**純顯示用的標記,不是結算的計算輸入**。結算的算術一律涵蓋
   * 整趟到目前為止的所有帳(見 server/utils/ledger.ts 的說明),
   * 這個欄位只決定「明細列表要列哪幾筆」。
   * 把它當成「這筆已結清」會算錯錢。
   */
  settlement_round_id: string | null;
  payers: Array<{ member_id: string; amount_minor: number }>;
  shares: Array<{ member_id: string; amount_minor: number }>;
}

export interface Net { memberId: string; netMinor: number; }
export interface Transfer { from: string; to: string; amountMinor: number; }

/**
 * 公費的收支,逐幣別分開(和結算一樣,絕不跨幣別相加)。
 *
 * remainingMinor = 投入 − 公費付掉的 − 已退還。
 * 這個數字就是「公費現在還剩多少現金」。
 *
 * ⚠️ 它等於公費成員淨額的相反數:`公費淨額 === −remainingMinor`。
 * 淨額含投入 / 退還(見 server/utils/ledger.ts 開頭),兩條路徑必須給出
 * 同一個數字 —— 這是這套語意的正確性支點,不是巧合。
 */
export interface PotCurrency {
  currency: string;
  /** 大家投入公費的總額 */
  contributedMinor: number;
  /** 公費付掉的支出 */
  spentMinor: number;
  /** 公費已經退還出去的 */
  refundedMinor: number;
  /** 還剩多少 */
  remainingMinor: number;
  /** 誰投入了多少(不含退還) */
  contributions: Array<{ memberId: string; amountMinor: number }>;
  /** 公費已退還給誰多少 */
  refunds: Array<{ memberId: string; amountMinor: number }>;
}

export interface PotSummary {
  memberId: string;
  name: string;
  by_currency: PotCurrency[];
}

export interface Balance {
  base_currency: string;
  by_currency: Record<string, {
    nets: Net[];
    /** 完整轉帳建議(含公費的腿) */
    transfers: Transfer[];
    /** 兩端都不是公費 —— 結算回合會真的寫進帳的就是這些 */
    recorded: Transfer[];
    /** 任一端是公費 —— 唯讀,旅程結束用「退還」處理,不要現在轉 */
    deferred: Transfer[];
  }>;
  per_member: Record<string, {
    sharedOwedBase: number; personalBase: number; totalBase: number; unconverted: number;
  }>;
  /** 這趟沒有設公費時是 null */
  pot: PotSummary | null;
  disclaimer: string;
  rate_attribution: string;
}

export type ReservationStatus = 'pending' | 'booked' | 'cancelled';

/**
 * ⚠️ 兩個時間不要搞混:
 *   opens_at_utc    什麼時候開放搶(提醒看這個)
 *   booked_for_utc  訂到的是哪一餐(行程看這個)
 */
/**
 * 一次結算回合。**一個回合只結一個幣別。**
 *
 * seq = 同一趟同一幣別的第幾次結算(畫面上的「第 2 次」)。
 * reverted_at 有值 = 被撤銷過(列會留著,帳上看得出來)。
 */
export interface SettlementRound {
  id: string;
  currency: string;
  seq: number;
  label: string | null;
  note: string | null;
  created_at: string;
  reverted_at: string | null;
  item_count: number;
  transfer_count: number;
  transfer_total_minor: number;
}

/**
 * 結算預覽的一個幣別區塊。
 *
 * ⚠️ `items` 和 `nets`/`recorded` 的範圍**刻意不同**:
 *   items    只有還沒列入任何回合的支出 → 這是「明細」
 *   nets 等  整趟到現在的算術結果        → 這是「結果」
 * 只算未結子集會重複要錢,原因見 server/utils/ledger.ts。
 */
export interface RoundPreviewBlock {
  currency: string;
  /** 這次會是第幾次結算 */
  seq: number;
  items: Expense[];
  item_count: number;
  /** 整趟淨額(含公費,公費那一列 = −公費剩餘),加起來必為 0 */
  nets: Net[];
  /** 兩端都不是公費 —— 結算會真的寫下來的 */
  recorded: Transfer[];
  /** 任一端是公費 —— 唯讀,旅程結束用「退還」處理 */
  deferred: Transfer[];
  /** 有值 = 不准結算,而且這就是原因 */
  blocked_reason: string | null;
}

export interface RoundPreview {
  pot_id: string | null;
  currencies: string[];
  blocks: RoundPreviewBlock[];
  all_settled: boolean;
}

export interface Reservation {
  id: string; name: string; url: string | null;
  opens_at_utc: string | null;
  booked_for_utc: string | null;
  booking_name: string | null;
  party_size: number | null;
  remind_before_min: number;
  reminded_at: string | null; status: ReservationStatus;
  note: string | null;
}
