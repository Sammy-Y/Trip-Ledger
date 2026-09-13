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
 * ══ 兩本帳,公費完全不進結算的算術 ══════════════════════════
 *
 * 使用者的心智模型(這是規格,不是實作細節):
 *
 *   信封   大家一開始各拿一筆錢出來放進去。之後**用公費付的**支出就直接
 *          從餘額扣掉,不追究那一筆是誰用的。
 *            餘額 = 投入 − 公費付掉的 − 已退還
 *          旅程結束把餘額分回去(分法由使用者自己決定,見 overview.vue 的退還)。
 *
 *   人對人  「A 先墊了錢」就是 A 和其他人之間的事,**跟公費一點關係都沒有**——
 *          不會因為 A 投了多少公費而變多或變少。
 *            淨額 = 他為「人付的」共同花費墊掉的 − 他在那些支出裡的分攤
 *                   + 他付出去的人對人還款 − 他收到的人對人還款
 *
 * 所以這個模組**只算人對人那一本**,而且公費從頭到尾不會出現在 nets 裡:
 *
 *   ① 公費付掉的支出:整筆排除(付款那一邊、分攤那一邊都排)。
 *      它已經被信封吸收了 —— 記一筆的當下就從餘額扣掉,沒有人欠任何人。
 *   ② 投入 / 退還:排除(任一端是公費的 settlement)。
 *      投入是「把現金放進信封」,不是還款。
 *
 * 於是 Σ(淨額) = 0 只涵蓋真人,而且成立得很直接:每一筆進入算術的支出,
 * 付款合計 == 分攤合計 == 金額,人對人的還款是對稱的兩腿。
 *
 * ── 為什麼不是「把公費當成一個成員一起算」──────────────────
 *
 * 試過那個做法(把投入算進淨額、公費當完整成員、它的腿標成 deferred)。
 * 算術是對的 —— 每個人最後掏出的錢分毫不差等於他該分攤的。但它**把人對人的債
 * 偷偷改道走信封**,而那正好違反上面那條規格:
 *
 *   三人各投 5,000(信封 15,000,一毛沒花),A 自己墊了 3,000 的飯三人均分
 *     那個做法  人對人「不用轉帳」,改成信封退 A 7,000 / B 4,000 / C 4,000
 *     這一版    B→A 1,000、C→A 1,000,信封照舊各退 5,000
 *
 * 兩種走法最後每個人都掏 1,000,錢沒有算錯。但前者會在畫面上寫
 * 「人跟人之間不用轉帳」,而事實是 B 和 C 各欠 A 一千 —— 那不是簡化,是說謊。
 * 而且它讓「信封要退多少給誰」變成取決於誰欠誰,信封就再也不是一個
 * 可以獨立對帳的現金餘額了。
 *
 * ── 那「公費付的支出」的 shares 還有什麼用 ─────────────────
 *
 * 純顯示。它讓明細頁答得出「這筆是哪幾個人一起用的」,但**不進任何算術**——
 * 信封的錢是共有的,花掉就是花掉。這也是為什麼公費付的支出在明細頁
 * 不列分攤清單(見 ExpenseDetail 的 paidByPot)。
 *
 * ══ deferred 永遠是空的(欄位留著,是防線不是功能)═══════════
 *
 * 公費不在 nets 裡 ⇒ minCashFlow 不可能吐出碰到公費的腿 ⇒ deferred 恆為 []。
 * 那兩個欄位(recorded / deferred)因此留著當**防線**:萬一哪天有人讓公費
 * 重新進了 nets,它的腿會落進 deferred 而不是被結算回合寫成真的轉帳。
 * 免費的保險,不要拿掉。
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
   * 人對人的淨額,加起來必為 0。**公費不在裡面**(見開頭那段):
   * 公費付掉的支出整筆排除、投入 / 退還也排除。
   */
  nets: Net[];
  /** 轉帳建議。公費不在 nets 裡,所以這些的兩端一定都是真人 */
  transfers: Transfer[];
  /** 兩端都不是公費 —— 結算回合只寫這些。實務上 === transfers */
  recorded: Transfer[];
  /** 任一端是公費 —— **恆為空**,留著當防線(見開頭最後一段) */
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

  /*
    ⚠️ 下面 paid 與 owed 兩句各有一段一模一樣的
    `AND NOT EXISTS (... m.is_pot = 1)` —— 那是「這筆是公費付的就整筆排除」。
    **兩邊必須逐字相同**:只排付款那一邊的話,公費付的支出會留下一堆沒有
    對應付款的分攤,淨額就不是零和,而 minCashFlow 對非零和輸入會**靜靜**
    回傳不完整的清單(settle.ts 的 break),錢就這樣無聲消失。

    抽成常數再插進樣板字串比較不會抄錯,但 SQL 一律靜態字串是這個 repo 的鐵則
    (test/sql-safety.test.ts 把任何插值本身當失敗,不看插的是不是常數)。
    所以寫兩份,改由 test/ledger.test.ts 的防漂移檢查比對它們一致。

    用 EXISTS + members.is_pot 而不是帶 potId 參數:potId 是同一批
    Promise.all 撈回來的,要用它就得先多等一次往返。
  */
  const [paid, owed, settled, curs, pot] = await Promise.all([
    dbh.prepare(
      `SELECT e.currency, p.member_id, SUM(p.amount_minor) AS amt
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM expense_payers pp JOIN members m ON m.id = pp.member_id
           WHERE pp.expense_id = e.id AND m.is_pot = 1
         )
       GROUP BY e.currency, p.member_id`,
    ).bind(tripId, curArg).all<AmountRow>(),
    dbh.prepare(
      `SELECT e.currency, s.member_id, SUM(s.amount_minor) AS amt
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM expense_payers pp JOIN members m ON m.id = pp.member_id
           WHERE pp.expense_id = e.id AND m.is_pot = 1
         )
       GROUP BY e.currency, s.member_id`,
    ).bind(tripId, curArg).all<AmountRow>(),
    dbh.prepare(
      `SELECT currency, from_member, to_member, SUM(amount_minor) AS amt
       FROM settlements
       WHERE trip_id = ?1 AND (?2 IS NULL OR currency = ?2)
       GROUP BY currency, from_member, to_member`,
    ).bind(tripId, curArg).all<SettledRow>(),
    /*
      幣別集合要**不管誰付的**,所以單獨查一次。
      少了這一句,「這個幣別只有公費付的支出」會整個從 ledger.currencies 消失,
      於是結算頁沒有那一塊 → 那幾筆永遠蓋不到章 → 未結明細裡卡著永遠清不掉的東西。
    */
    dbh.prepare(
      `SELECT DISTINCT currency FROM expenses
       WHERE trip_id = ?1 AND kind = 'shared' AND (?2 IS NULL OR currency = ?2)`,
    ).bind(tripId, curArg).all<{ currency: string }>(),
    dbh.prepare(`SELECT id FROM members WHERE trip_id = ? AND is_pot = 1`)
      .bind(tripId).first<{ id: string }>(),
  ]);

  const paidR = paid.results ?? [];
  const owedR = owed.results ?? [];
  const settledR = settled.results ?? [];
  const potId = pot?.id ?? null;

  /*
    投入(人→公費)與退還(公費→人)都不是還款,是把現金搬進/搬出信封 ——
    人對人那一本不認它們(見開頭)。**只排一邊是沒用的**:排投入不排退還的話,
    收到退還的人淨額會莫名往下掉一截,看起來就像他突然欠了一筆。
  */
  const p2pR = potId === null
    ? settledR
    : settledR.filter((r) => r.from_member !== potId && r.to_member !== potId);

  // ⚠️ 幣別集合取聯集,而且每一份來源都不能少:
  //   curs      所有共同支出的幣別(**不管誰付的**)—— 公費付的那些要蓋得到章
  //   settledR  全部的 settlements(**含投入 / 退還**,即使它們不進淨額)——
  //             「只有公費投入、還沒開始花」的幣別總覽有剩餘,結算頁至少要
  //             存在同一塊才不會讓人以為漏了東西;「有還款卻沒有任何共同支出」
  //             (支出被刪掉、幣別記錯)也靠它
  // 多一塊空的無害,少一塊會掉錢。
  const currencies = [...new Set([
    ...(curs.results ?? []).map((r) => r.currency),
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
      // p2pR,不是 settledR —— 投入 / 退還不是還款(見開頭)。
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
 * 逐筆檢查兩件事,兩件都會讓結算算出錯的金額:
 *
 *   ① 付款合計 != 分攤合計
 *   ② 一筆支出**公費和人一起付**
 *
 * ② 為什麼也算「不平衡」:這個模組把公費付的支出**整筆**排除
 * (見開頭的兩本帳)。判準是「公費是付款人之一」,所以混合付款的那一筆
 * 會連同那個人墊的錢一起被丟掉 —— 淨額仍然零和(兩邊一起丟),
 * 所以 ① 抓不到它,但那個人的墊款就這樣無聲消失了。
 *
 * 混合付款在語意上本來就沒有說得通的意思(那個人墊的算不算他墊的?),
 * 所以 expenses.post / expenses[id].patch 兩支寫入端點都擋掉了。
 * 這裡是**第二道**:資料庫可能被直接改過(匯入腳本、手動 SQL),
 * 而這次改動之前建的資料也可能有。結算是把錯誤變成真實金錢的那一步,
 * 寧可擋住整個回合,也不要靜靜吃掉某個人的錢。
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
            COALESCE((SELECT SUM(s.amount_minor) FROM expense_shares s WHERE s.expense_id = e.id), 0) AS owed,
            (SELECT COUNT(*) FROM expense_payers p2 WHERE p2.expense_id = e.id) AS n_payers,
            (SELECT COUNT(*) FROM expense_payers p3 JOIN members m ON m.id = p3.member_id
              WHERE p3.expense_id = e.id AND m.is_pot = 1) AS n_pot_payers
     FROM expenses e
     WHERE e.trip_id = ?1 AND e.kind = 'shared' AND (?2 IS NULL OR e.currency = ?2)`,
  ).bind(tripId, currency ?? null).all<{
    id: string; description: string; currency: string; paid: number; owed: number;
    n_payers: number; n_pot_payers: number;
  }>();

  return (rows.results ?? [])
    .filter((r) => r.paid !== r.owed || (r.n_pot_payers > 0 && r.n_payers > 1))
    .map(({ id, description, currency: cur, paid, owed }) =>
      ({ id, description, currency: cur, paid, owed }));
}
