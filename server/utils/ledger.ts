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
 *   ① 使用者照建議付了款、記成手動還款,下一回合把它吸收進來後
 *      吐出反方向的轉帳 —— 付款/反轉無限來回。
 *   ② 上一回合寫下的轉帳(source='round')在子集範圍裡找不到對應的債,
 *      於是第二回合把第一回合整個反轉回去。
 *
 *   ③ 投入公費也是一筆 settlement(人→公費),而它清掉的是「他對信封的欠款」。
 *      子集範圍切在投入的前面或後面,同一筆消費就會被要求付兩次。
 *
 * 守這三條的是 test/api.rounds.test.ts 的 [5] 與 [6]。
 *
 * 而「整趟都算」為什麼不會重複要錢:已經結算過的支出貢獻 net_r,
 * 而當時那個回合產生的 settlement 貢獻 −net_r,兩者相加恰好是 0。
 * 所以把舊帳一起算進來是**可證明的無操作**,而且順手讓
 * 「吸收手動還款」「補登過去日期的支出」「非後進先出地撤銷回合」三件事全部免費變安全。
 *
 * ══ 淨額**含**投入公費 / 公費退還 ═══════════════════════════
 *
 *   淨額 = Σ(這個人為共同花費付掉的) − Σ(這個人該分攤的)
 *          + Σ(他付出去的 settlement) − Σ(他收到的 settlement)
 *
 * settlements 一律照算,**包含任一端是公費的那些**:投入(人→公費)算他付出去,
 * 退還(公費→人)算他收到。人對人的還款當然也算。
 *
 * 為什麼要算:公費就是一個信封,大家先把錢放進去,之後直接從裡面付。
 * 投入是這個人真真實實掏出去的錢,和他刷卡墊一頓飯沒有任何差別 ——
 * 少算它,結算就會對著一個已經先付過錢的人說他還欠錢。實測過的例子:
 *
 *     MIN 投入 ¥20,000、Hsuan 投入 ¥15,000,公費付掉 ¥15,000 兩人均分。
 *     不算投入 →  MIN −7,500   Hsuan −7,500                (兩個人都「應付」)
 *     算投入   →  MIN +12,500  Hsuan +7,500  公費 −20,000
 *
 * 上面那排負數是錯的:兩個人各自先掏了 2 萬和 1.5 萬進信封,信封裡還躺著
 * ¥20,000 現金,沒有任何人欠任何人。把投入拿掉之後每個人的淨額就不再是
 * 「他這趟的收支」,而是「他還欠信封多少」—— 那個量在畫面上長得和欠款
 * 一模一樣,卻不能拿去跟人要錢。極端一點更明顯:MIN 一個人投 5 萬、Hsuan 投 0,
 * 不算投入的話畫面會叫**出了全部錢的那個人**再付一次給信封。
 *
 * 三個不變量:
 *   ① Σ(所有淨額) = 0          settlement 是對稱的兩腿,一加一減
 *   ② 公費淨額 = −公費剩餘      公費淨額 = 花掉 + 退還 − 投入 = −(投入 − 花掉 − 退還)
 *   ③ Σ(真人淨額) = 公費剩餘    由 ① ② 得到
 *
 * ② 是這套語意的正確性支點,而且是**兩條完全獨立的路徑算同一個數字**:
 * 一邊是 balance.get.ts 的 potSummary 從三個 SUM 直接減出來,
 * 一邊是這裡經過 netBalances 的一堆加減。對不上就代表有東西記錯了 ——
 * 最常見的是公費替自己分攤了一份,或有人把已經有帳的成員改標成公費。
 *
 * ══ 公費有剩餘的時候,那筆錢還沒有要退 ══════════════════════════
 *
 * ③ 的直接後果:旅程進行到一半,真人的淨額加起來會等於信封裡的現金,
 * 而那筆錢明天還要拿去買車票。看起來像是「大家都有錢可以收」,實際上不能收。
 *
 * 這個誤會要用**顯示**解決,不能用算術解決:公費的腿一律是 deferred
 * (下一段),畫面上講的是「旅程結束時退還」,永遠不是「現在去把錢要回來」。
 * 曾經試過相反的做法 —— 把投入 / 退還整個從淨額裡拿掉,讓剩餘不進結算算術。
 * 那確實讓剩餘消失了,代價是每個人的淨額同時失去意義(就是上面那排負數),
 * 而那個代價遠大於它想擋的誤會。線劃在「寫不寫進 settlements」,
 * 不是劃在「算不算進淨額」。
 *
 * ══ 公費在算術裡是完整成員,只在輸出時被排除 ═══════════════════
 *
 * 公費(is_pot)必須參與 netBalances,否則淨額加起來不等於 0,
 * 而 minCashFlow 對非零和輸入會**靜靜回傳不完整的轉帳清單**
 * (settle.ts 的 `if (credit <= 0 || debt >= 0) break`)—— 錢就這樣無聲消失。
 *
 * 但公費的腿不能寫成真的轉帳,兩個方向都不行:
 *
 *   剩餘 > 0(常態)  公費淨額 < 0 ⇒ 腿是「公費 → 人 X 元」=「結束時退還 X」。
 *                    寫下去等於第一晚就把信封清空退還,而那筆錢明天還要用。
 *   剩餘 < 0(超支)  公費淨額 > 0 ⇒ 腿是「人 → 公費 X 元」=「還要再投入 X」。
 *                    寫下去等於**幫他記了一筆他沒付的投入**:信封裡憑空多出 X 元,
 *                    總覽的剩餘據此叫下一個人少投、或多退還給別人。
 *
 * 方向相反,結論一樣:公費的腿一律不寫。投入與退還都是使用者自己在總覽頁
 * 按下去的動作,那一按代表現金真的換了手,不是系統替他假設的。
 *
 * 所以輸出分兩堆:
 *   recorded  兩端都不是公費 → 這才是回合要寫進 settlements 的
 *   deferred  任一端是公費   → 唯讀顯示,永遠不寫入(投入/退還都在總覽頁處理)
 *
 * 這樣安全的理由是 minCashFlow 的**單邊性**:每個成員只會出現在轉帳的一側
 * (債權人永遠是收款方、債務人永遠是付款方)。所以丟掉公費的腿之後,
 * 剩下的人身上的殘額**同號**,不會有人被多要錢也不會有人被多付錢。
 */

/*
  ⚠️ 這裡刻意**不再** `export type { Net, Transfer }`。
  server/utils/ 走 Nitro 自動匯入,同一個名字被兩個檔案匯出時它會挑一個、
  並在每次 build 與 dev 啟動時印一行 "Duplicated imports Net/Transfer" 警告。
  那兩個型別的本體在 ./settle.ts,這裡的轉出只是方便,沒有任何人用
  (呼叫端一律 `from './settle'`)—— 拿掉之後警告消失,型別來源也只剩一處。
*/

export interface LedgerBlock {
  currency: string;
  /**
   * 含公費的完整淨額(加起來必為 0)。
   * **含投入公費 / 公費退還** —— 見開頭那段。公費那一列的值 = −公費剩餘。
   */
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
  //
  // 「有還款卻沒有任何共同支出」的幣別(支出後來被刪掉、或使用者把幣別記錯)
  // 淨額不是 0,少了它就有一筆債完全沒有畫面可以看到。
  // 「只有公費投入、還沒開始花」的幣別同理:那筆現金真的躺在信封裡,
  // 淨額是「投入的人 +X、公費 −X」,結算頁必須看得到。
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
      // settlements 全部照算,**包含任一端是公費的**(投入 / 退還)——
      // 見開頭「淨額含投入公費 / 公費退還」。公費不必特別處理:
      // 它就是 netBalances 眼中的一個普通成員,腿要不要寫由下面的
      // recorded / deferred 決定,不是由這裡少算一筆決定。
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
