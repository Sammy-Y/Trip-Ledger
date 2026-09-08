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
 * (以前這裡還列了第三條「公費先幫某人墊款之後子集算法會重複要錢」。
 *  淨額不含投入/退還之後那個場景**不再分得出**整趟與子集的差別 ——
 *  公費的兩條腿根本不在算術裡了。守子集算術的責任全部落在上面這兩條,
 *  也就是 test/api.rounds.test.ts 的 [5] 與 [6]。)
 *
 * 而「整趟都算」為什麼不會重複要錢:已經結算過的支出貢獻 net_r,
 * 而當時那個回合產生的 settlement 貢獻 −net_r,兩者相加恰好是 0。
 * 所以把舊帳一起算進來是**可證明的無操作**,而且順手讓
 * 「吸收手動還款」「補登過去日期的支出」「非後進先出地撤銷回合」三件事全部免費變安全。
 *
 * ══ 淨額**不含**投入公費 / 公費退還 ══════════════════════════
 *
 *   淨額 = Σ(這個人為共同花費付掉的) − Σ(這個人該分攤的) − Σ(人對人的還款)
 *
 * 排除的是**任一端為公費的 settlement**:投入(人→公費)和退還(公費→人)兩邊都排。
 * 人對人的還款照算 —— 手動「標記已還款」和回合寫下的轉帳都是真實的債務清償。
 *
 * 為什麼要排:投入在資料上就是一筆 人→公費 的 settlement。把它算進淨額的話,
 * 「公費手上還剩多少」會被拆成兩列掛在真人身上:
 *
 *     MIN +38,942   Hsuan +28,944   公費 −67,886    ← 兩人合計剛好 = 公費剩餘
 *
 * 於是「結算頁只講真人與公費花費」根本做不到 —— 光把公費那一列藏起來,
 * 剩餘還是留在真人的淨額裡。剩餘是總覽頁的事(pot.by_currency[].remainingMinor),
 * 要讓它不出現在結算的算術裡,就得把投入/退還整個拿掉。排掉之後同一批資料變成:
 *
 *     MIN −11,058   Hsuan −21,056   公費 +32,114
 *
 * 兩個不變量:
 *   ① Σ(所有淨額) = 0         照舊(排掉的是對稱的兩腿,一加一減剛好抵銷)
 *   ② Σ(真人淨額) = −(公費花費)  新的。公費自己不分攤,所以它的淨額恰好等於
 *      它付掉的錢 —— 也就是說「公費花費」不是另外算出來的數字,
 *      就是公費的淨額換個符號說。這條一眼可驗,是新語意的正確性支點。
 *
 * ⚠️ 舊的不變量「公費剩餘 = −公費淨額」到這裡就**不成立了**。
 * 剩餘只剩一條計算路徑(balance.get.ts 的 potSummary),那是刻意的:
 * 兩條路徑算同一個數字的好處換成了「剩餘完全不進結算算術」。
 *
 * ══ 債沒有消失,只是改走公費 ═══════════════════════════════════
 *
 * 「投入不均的債會不見」是讀到這裡的第一個反應。不會 —— 它只是改了路由。
 * MIN 投 5 萬、Hsuan 投 0,公費花掉 32,114 兩人均分:
 *   舊語意 Hsuan → MIN 16,057(人對人,回合會寫下去)
 *   新語意 Hsuan 淨額 −16,057(他確實還欠,只是對象變成公費信封)
 *          → 他到總覽投入 16,057 → 信封有 17,886 + 16,057 = 33,943
 *          → 退還 MIN 33,943,而 MIN 實付 50,000 − 16,057 = 33,943 ✓ 完全對得上
 * 真人的淨額仍然看得到他欠多少,只是清償路徑經過信封。
 *
 * ══ 公費在算術裡是完整成員,只在輸出時被排除 ═══════════════════
 *
 * 公費(is_pot)必須參與 netBalances,否則淨額加起來不等於 0,
 * 而 minCashFlow 對非零和輸入會**靜靜回傳不完整的轉帳清單**
 * (settle.ts 的 `if (credit <= 0 || debt >= 0) break`)—— 錢就這樣無聲消失。
 *
 * 但公費的腿不能寫成真的轉帳。新語意下公費淨額 = +公費花費,所以公費恆為債權人,
 * 它的腿長成「人 → 公費 X 元」= 「這個人還要投入 X 元」。照著寫進 settlements
 * 等於**幫他記了一筆他沒付的投入**:信封裡憑空多出 X 元,總覽的剩餘據此
 * 叫下一個人少投、或多退還給別人。投入是使用者自己在總覽頁按下去的動作。
 * (舊語意下這條腿是反方向的「公費 → 人」,寫下去等於第一晚就把信封清空退還,
 *  而那筆錢明天還要用。方向反了,結論一樣:公費的腿一律不寫。)
 *
 * 所以輸出分兩堆:
 *   recorded  兩端都不是公費 → 這才是回合要寫進 settlements 的
 *   deferred  任一端是公費   → 唯讀顯示,永遠不寫入(投入/退還都在總覽頁處理)
 *
 * 這樣安全的理由是 minCashFlow 的**單邊性**:每個成員只會出現在轉帳的一側
 * (債權人永遠是收款方、債務人永遠是付款方)。所以丟掉公費的腿之後,
 * 剩下的人身上的殘額**同號**,不會有人被多要錢也不會有人被多付錢。
 */

export type { Net, Transfer };

export interface LedgerBlock {
  currency: string;
  /**
   * 含公費的完整淨額(加起來必為 0)。
   * **不含投入公費 / 公費退還** —— 見開頭那段。公費那一列的值 = 公費花掉的錢。
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

  // ⚠️ 只有「兩端都是真人」的還款進淨額 —— 這是新語意的全部實作(見開頭那段)。
  //
  // 排除條件是「任一端是公費」,所以投入(人→公費)和退還(公費→人)一起排掉。
  // **只排一邊是沒用的**:排投入不排退還的話,Σ(真人淨額) = −(公費花費)
  // 會差掉已退還的金額,而那個差額看起來就像是有人莫名多欠了一筆。
  //
  // 這一步刻意留在 JS,不寫成 SQL 的 WHERE:potId 是同一批 Promise.all 撈回來的,
  // 要在 SQL 裡用就得多一次往返(或把它塞進子查詢,讓那句 SQL 又長一截)。
  // 一趟旅程的 settlements 是幾十列的量級,在記憶體濾掉是零成本的。
  const p2pR = potId === null
    ? settledR
    : settledR.filter((r) => r.from_member !== potId && r.to_member !== potId);

  // ⚠️ 幣別集合必須把 settlements 也算進來,而且是**全部**的 settlements,
  // 不是只有進淨額的那份 p2pR。
  //
  // 人對人的那部分是必要的:「有還款卻沒有任何共同支出」的幣別(支出後來被刪掉、
  // 或使用者把幣別記錯)淨額不是 0,少了它就有一筆債完全沒有畫面可以看到。
  // 而「只有公費投入」的幣別現在算出來是個空區塊(投入不進淨額)—— 留著是刻意的:
  // 總覽頁那個幣別有剩餘,結算頁至少要存在同一塊才不會讓人以為漏了東西。
  // 多一塊空的無害,少一塊會掉錢,所以取聯集。
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
      // p2pR,不是 settledR —— 投入/退還不進淨額。
      settled: p2pR.filter((r) => r.currency === cur)
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
