import { netBalances, minCashFlow, type Net, type Transfer } from './settle';

/**
 * 整趟帳本 —— 「誰欠誰多少」的唯一計算來源。
 *
 * balance.get.ts 和結算回合(rounds/*)都呼叫這裡,**絕對不要各自再寫一份查詢**。
 * 兩邊算出來的數字必須逐分錢一致,否則結算頁說要付 1,850、按下去卻寫進 1,900。
 *
 * ══ 這個模組最重要的一件事:算術範圍 vs 明細範圍 ══════════════
 *
 * 結算回合的需求是「已結清的標記起來,下次從沒標記的地方開始」。
 * 直覺的做法是「只把沒標記的帳拿來算」—— **那是錯的,而且會算錯錢。**
 *
 *   算術範圍(nets/transfers)= 整趟到目前為止的所有帳,永遠不看標記
 *   明細範圍(列表要列哪幾筆)= 只有還沒標記的那些
 *
 * 為什麼算術不能只看「沒標記的子集」:**settlement 這一列沒有任何欄位
 * 指向它清掉的是哪一筆債**。所以只要算術範圍是個真子集,就一定會遇到
 * 「這筆還款被算進來了,但它對應的那筆債在範圍外」,於是同一筆錢被要求付兩次。
 * 具體會壞掉的流程(都實測過):
 *
 *   ① 公費先幫某人墊款(pot/moves direction=out)之後,子集算法會再叫
 *      另一個人付一次公費已經付掉的錢。
 *   ② 使用者照建議付了款、記成手動還款,下一回合把它吸收進來後
 *      吐出反方向的轉帳 —— 付款/反轉無限來回。
 *
 * 而「整趟都算」為什麼不會重複要錢:已經結算過的支出貢獻 net_r,
 * 而當時那個回合產生的 settlement 貢獻 −net_r,兩者相加恰好是 0。
 * 所以把舊帳一起算進來是**可證明的無操作**,而且順手讓
 * 「吸收手動還款」「補登過去日期的支出」「非後進先出地撤銷回合」三件事全部免費變安全。
 *
 * ══ 公費在算術裡是完整成員,只在輸出時被排除 ═══════════════════
 *
 * 公費(is_pot)必須參與 netBalances,否則淨額加起來不等於 0,
 * 而 minCashFlow 對非零和輸入會**靜靜回傳不完整的轉帳清單**
 * (settle.ts 的 `if (credit <= 0 || debt >= 0) break`)—— 錢就這樣無聲消失。
 *
 * 但公費的腿不能寫成真的轉帳:第一天晚上結算時,公費淨額 = −(手上剩的現金),
 * 直接照 minCashFlow 寫下去等於「把公費清空退還給大家」,而那筆錢明天還要用。
 *
 * 所以輸出分兩堆:
 *   recorded  兩端都不是公費 → 這才是回合要寫進 settlements 的
 *   deferred  任一端是公費   → 唯讀顯示,永遠不寫入(旅程結束用「退還」處理)
 *
 * 這樣安全的理由是 minCashFlow 的**單邊性**:每個成員只會出現在轉帳的一側
 * (債權人永遠是收款方、債務人永遠是付款方)。所以丟掉公費的腿之後,
 * 剩下的人身上的殘額**同號**,不會有人被多要錢也不會有人被多付錢。
 */

export type { Net, Transfer };

export interface LedgerBlock {
  currency: string;
  /** 含公費的完整淨額(加起來必為 0) */
  nets: Net[];
  /** 含公費腿的完整轉帳建議 */
  transfers: Transfer[];
  /** 兩端都不是公費 —— 結算回合只寫這些 */
  recorded: Transfer[];
  /** 任一端是公費 —— 只顯示,不寫入 */
  deferred: Transfer[];
}

export interface Ledger {
  potId: string | null;
  currencies: string[];
  byCurrency: Record<string, LedgerBlock>;
}

type AmountRow = { currency: string; member_id: string; amt: number };
type SettledRow = { currency: string; from_member: string; to_member: string; amt: number };

/**
 * 算出整趟的帳本。
 *
 * @param currency 只算某一個幣別(結算回合一次只處理一個幣別)。不給就全部。
 */
export async function tripLedger(
  dbh: D1Database,
  tripId: string,
  currency?: string | null,
): Promise<Ledger> {
  // SQL 一律靜態字串。可選的幣別條件用 `?2 IS NULL OR ...` 的 sentinel 寫法,
  // 不拼接 WHERE(見 test/sql-safety.test.ts)。
  const curArg = currency ?? null;

  const [paid, owed, settled, pot] = await Promise.all([
    dbh.prepare(
      `SELECT e.currency, p.member_id, SUM(p.amount_minor) AS amt
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)
       GROUP BY e.currency, p.member_id`,
    ).bind(tripId, curArg).all<AmountRow>(),
    dbh.prepare(
      `SELECT e.currency, s.member_id, SUM(s.amount_minor) AS amt
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)
       GROUP BY e.currency, s.member_id`,
    ).bind(tripId, curArg).all<AmountRow>(),
    dbh.prepare(
      `SELECT currency, from_member, to_member, SUM(amount_minor) AS amt
       FROM settlements
       WHERE trip_id = ?1 AND (?2 IS NULL OR currency = ?2)
       GROUP BY currency, from_member, to_member`,
    ).bind(tripId, curArg).all<SettledRow>(),
    dbh.prepare(`SELECT id FROM members WHERE trip_id = ? AND is_pot = 1`)
      .bind(tripId).first<{ id: string }>(),
  ]);

  const paidR = paid.results ?? [];
  const owedR = owed.results ?? [];
  const settledR = settled.results ?? [];
  const potId = pot?.id ?? null;

  // ⚠️ 幣別集合必須把 settlements 也算進來。
  // 只看 paid/owed 的話,「只有公費投入、還沒有任何共同支出」的幣別
  // 會完全不存在於結果裡 —— 於是總覽顯示公費有 20,000,
  // 結算頁卻連那個幣別的區塊都沒有,而「剩餘 = −淨額」這個不變量直接破掉。
  const currencies = [...new Set([
    ...paidR.map((r) => r.currency),
    ...owedR.map((r) => r.currency),
    ...settledR.map((r) => r.currency),
  ])].sort();

  const byCurrency: Record<string, LedgerBlock> = {};
  for (const cur of currencies) {
    // netBalances 的成員集合是**從資料列推導**出來的,不是 SELECT members ——
    // 這是淨額能加總為 0 的前提。用成員表去掃的話,萬一有列指向
    // 別的旅程的成員 id(expenses.post 目前沒驗這件事)就會被靜靜丟掉。
    const nets = netBalances({
      paid: paidR.filter((r) => r.currency === cur)
        .map((r) => ({ memberId: r.member_id, amountMinor: r.amt })),
      owed: owedR.filter((r) => r.currency === cur)
        .map((r) => ({ memberId: r.member_id, amountMinor: r.amt })),
      settled: settledR.filter((r) => r.currency === cur)
        .map((r) => ({ from: r.from_member, to: r.to_member, amountMinor: r.amt })),
    });
    const transfers = minCashFlow(nets);
    const touchesPot = (t: Transfer) => !!potId && (t.from === potId || t.to === potId);

    byCurrency[cur] = {
      currency: cur,
      nets,
      transfers,
      recorded: transfers.filter((t) => !touchesPot(t)),
      deferred: transfers.filter(touchesPot),
    };
  }

  return { potId, currencies, byCurrency };
}

/**
 * 寫錢之前的最後一道檢查。
 *
 * minCashFlow 對「淨額加起來不等於 0」的輸入不會拋錯,只會**靜靜回傳不完整的清單**
 * (settle.ts 的 break)。所以任何要把轉帳寫進資料庫的路徑,
 * 都必須先自己證明輸入是零和的,不能指望下游會抱怨。
 *
 * 回傳 null = 沒問題;回傳字串 = 可以直接丟給使用者看的原因。
 */
export function assertZeroSum(block: LedgerBlock): string | null {
  const total = block.nets.reduce((s, n) => s + n.netMinor, 0);
  if (total !== 0) {
    return `帳目不平衡:${block.currency} 的淨額總和是 ${total},應該是 0。`
      + '這代表有支出的付款金額與分攤金額對不上,結算已中止以免寫入錯誤的金額。';
  }
  if (block.nets.some((n) => !Number.isInteger(n.netMinor))) {
    return `帳目異常:${block.currency} 出現非整數的淨額。`;
  }
  return null;
}

/**
 * 逐筆檢查「付款合計 == 分攤合計」。
 *
 * expenses.post 寫入時會驗,但資料庫可能被直接改過(匯入腳本、手動 SQL、
 * 未來的編輯功能)。結算是把錯誤變成真實金錢的那一步,所以這裡再驗一次。
 */
export async function findUnbalancedExpenses(
  dbh: D1Database,
  tripId: string,
  currency?: string | null,
): Promise<Array<{
  id: string; description: string; currency: string; paid: number; owed: number;
}>> {
  // ⚠️ currency 一定要 SELECT 出來。少了它,呼叫端就沒辦法把「哪個幣別有問題」
  // 分開 —— 結果會變成某一個幣別壞掉就把**所有**幣別的結算按鈕一起鎖死,
  // 而且畫面上看不到是哪一筆造成的(實際發生過)。
  const rows = await dbh.prepare(
    `SELECT e.id, e.description, e.currency,
            COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p WHERE p.expense_id = e.id), 0) AS paid,
            COALESCE((SELECT SUM(s.amount_minor) FROM expense_shares s WHERE s.expense_id = e.id), 0) AS owed
     FROM expenses e
     WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)`,
  ).bind(tripId, currency ?? null).all<{
    id: string; description: string; currency: string; paid: number; owed: number;
  }>();

  return (rows.results ?? []).filter((r) => r.paid !== r.owed);
}
