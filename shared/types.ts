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

/**
 * 一筆換匯。「出發前在台灣分次換好」在資料上就是這個。
 *
 * ⚠️ **沒有 rate 欄位,那是刻意的。** 資料庫存兩邊的金額,匯率一律由
 * shared/money.ts 的 exchangeRate() 算出來(理由見 schema.sql 的 fx_exchanges)。
 * 這裡如果多一個 rate,前端就會有兩個來源可以選,而它們遲早會不一致。
 *
 *   currency / amount_minor        換到的(例:JPY 5000)
 *   cost_currency / cost_minor     付出的(例:TWD 105000 → 有效匯率 0.21)
 */
export interface FxExchange {
  id: string;
  member_id: string;
  currency: string;
  amount_minor: number;
  cost_currency: string;
  cost_minor: number;
  exchanged_at: string;
  note: string | null;
  created_at: string;
}

export interface Net { memberId: string; netMinor: number; }
export interface Transfer { from: string; to: string; amountMinor: number; }

/**
 * 公費的收支,逐幣別分開(和結算一樣,絕不跨幣別相加)。
 *
 * remainingMinor = 投入 − 公費付掉的 − 已退還。
 * 這個數字就是「公費現在還剩多少現金」。
 *
 * ⚠️ 它和結算的淨額**完全無關**。公費不出現在 by_currency[].nets 裡
 * (見 server/utils/ledger.ts:那裡只算人對人那一本),所以剩餘不能從淨額推,
 * 淨額也不會因為信封裡有多少錢而改變。兩本帳各自獨立。
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

/**
 * 一個人在某一個幣別的**錢包**。issue #6
 *
 *   剩餘 = 換到的 − 所有從這個人手上離手的 + 收到的
 *
 * 「離手」是四種:自己付現的支出、投入公費的、付出去的還款、
 * 以及用這個幣別的現金再去換別的幣別(換回台幣、當地 ATM 提款都是這種)。
 * 「收到的」是別人還他的錢和公費退還 —— 那些錢真的進了他口袋。
 *
 * ── 為什麼四個流向要分開列,而不是只給一個剩餘 ──────────────
 *
 * 「我口袋剩多少」和「我花在自己身上多少」是**兩種讀法**,而且兩個都要:
 * 前者決定要不要再去換錢,後者是這趟的個人花費。合成一個數字之後
 * 兩個問題都答不出來(投入公費的錢確實離手了,但那不是「我花的」)。
 *
 * ⚠️ 這裡**完全不參與計價**:不進淨額、不進轉帳、不進結算回合。
 * 「沒有任何換匯紀錄時所有現有數字完全不變」是這個功能最重要的不變量,
 * 而它成立的原因就是這個型別只被 Balance.wallets 用到,沒有第二個出口。
 */
export interface WalletCurrency {
  currency: string;
  /** 換到多少(fx_exchanges.amount_minor 的加總) */
  exchangedInMinor: number;
  /**
   * 換這些錢付出去多少,**逐付出幣別分開**。
   *
   * 幾乎總是只有一種(台幣),但資料模型允許多種,所以這裡不假設。
   * 加權平均匯率 = costs[0].amountMinor / exchangedInMinor,由前端用
   * exchangeRate() 算 —— 只有一種付出幣別時才有意義(見上面的說明)。
   */
  costs: Array<{ currency: string; amountMinor: number }>;
  /** 自己付現花掉的(expense_payers 且 payment_method = 'cash',共同與個人都算) */
  cashSpentMinor: number;
  /** 投入公費的。這也是離手 —— 錢確實離開了他的口袋 */
  potContributedMinor: number;
  /** 付出去的還款(不含投入公費,那一項單獨列) */
  repaidOutMinor: number;
  /** 收到的還款 / 公費退還 */
  receivedInMinor: number;
  /** 拿這個幣別的現金再去換別的幣別,付出去的(換回台幣 / ATM 提款) */
  exchangedOutMinor: number;
  /** 還剩多少。負數只是**警告**,不是錯誤(代表在當地提過款沒記) */
  remainingMinor: number;
}

/**
 * 一個人的錢包,逐幣別分開(和結算一樣,絕不跨幣別相加)。
 *
 * ⚠️ `by_currency` **不會有本位幣那一格**。錢包問的是「口袋裡的外幣現金」,
 * 而本位幣在銀行帳戶裡 —— 這個 app 看不到帳戶餘額,所以硬給它一格的話
 * 離手那一邊會變成胡說(完整推導見 server/utils/wallet.ts 的 walletSummaries)。
 */
export interface WalletSummary {
  memberId: string;
  name: string;
  by_currency: WalletCurrency[];
}

export interface Balance {
  base_currency: string;
  by_currency: Record<string, {
    nets: Net[];
    /** 完整轉帳建議(含公費的腿) */
    transfers: Transfer[];
    /** 兩端都不是公費 —— 結算回合會真的寫進帳的就是這些 */
    recorded: Transfer[];
    /** 任一端是公費 —— **恆為空**(公費不在 nets 裡)。留著當防線 */
    deferred: Transfer[];
  }>;
  per_member: Record<string, {
    sharedOwedBase: number; personalBase: number; totalBase: number; unconverted: number;
  }>;
  /** 這趟沒有設公費時是 null */
  pot: PotSummary | null;
  /**
   * 每人一塊錢包(換了多少 / 花了多少 / 還剩多少)。issue #6
   *
   * **完全沒有換匯紀錄的旅程回空陣列** —— 那是回歸保護:
   * 這個功能上線前的每一趟旅程,畫面與數字都必須一個字都不變。
   */
  wallets: WalletSummary[];
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
  /** 整趟的人對人淨額(**不含公費**),加起來必為 0 */
  nets: Net[];
  /** 兩端都不是公費 —— 結算會真的寫下來的 */
  recorded: Transfer[];
  /** 任一端是公費 —— **恆為空**(公費不在 nets 裡)。留著當防線 */
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
