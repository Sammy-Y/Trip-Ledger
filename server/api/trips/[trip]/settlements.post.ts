import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';
import { tripLedger } from '../../../utils/ledger';

type Body = {
  from_member: string;
  to_member: string;
  currency: string;
  amount_minor: number;
  note?: string;
};

/**
 * 記一筆還款(結算頁的「標記已還款」)。
 *
 * 這裡收的是 amount_minor(最小單位整數),不是人類單位 ——
 * 因為金額直接來自 balance 的轉帳建議,不需要再過一次 toMinor,
 * 也避免浮點轉換讓還款額和應付額差一分錢、結算永遠歸不了零。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);

  if (!b?.from_member || !b?.to_member || !b?.currency) {
    throw createError({ statusCode: 400, statusMessage: 'from_member / to_member / currency required' });
  }
  if (b.from_member === b.to_member) {
    throw createError({ statusCode: 400, statusMessage: '付款人與收款人不能是同一個人' });
  }
  if (!Number.isInteger(b.amount_minor) || b.amount_minor <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'amount_minor 必須是大於 0 的整數(最小單位)' });
  }

  const [members, currency] = await Promise.all([
    // name 也撈出來 —— 上限被擋掉的錯誤訊息要說得出「不該還錢給誰」,
    // 光丟兩個數字使用者不知道該去改哪一邊(id 對他來說是亂碼)。
    dbh.prepare(`SELECT id, name FROM members WHERE trip_id = ? AND id IN (?, ?)`)
      .bind(trip.id, b.from_member, b.to_member).all<{ id: string; name: string }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(b.currency).first<{ code: string }>(),
  ]);

  // 兩個人都得在這趟旅程裡。少一個就代表 id 打錯或屬於別的旅程。
  if ((members.results ?? []).length !== 2) {
    throw createError({ statusCode: 400, statusMessage: '付款人或收款人不屬於這趟旅程' });
  }
  const nameOf = (mid: string) =>
    (members.results ?? []).find((m) => m.id === mid)?.name ?? mid;
  if (!currency) {
    throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${b.currency}` });
  }

  // ── 公費退還的上限,這裡也要守 ────────────────────────────────
  //
  // pot/moves.post.ts 有這個檢查,但**這一支寫的是完全一樣的那一列**。
  // 只守一邊的話,擋在那邊的請求換成打這裡就過了(實測:pot/moves 回 400,
  // 同一筆金額改打 /settlements 回 201,然後結算就寫出一筆假的人對人轉帳)。
  //
  // 退還公費從來沒收到的錢會讓收款人淨額多出那麼多,結算就會叫**另一個人**
  // 付一筆不存在的錢給他,而且那筆會被結算回合寫成真的轉帳。
  const pot = await dbh.prepare(
    `SELECT id, name FROM members WHERE trip_id = ? AND is_pot = 1`,
  ).bind(trip.id).first<{ id: string; name: string }>();

  if (pot && b.from_member === pot.id) {
    const flow = await dbh.prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_minor) FROM settlements
                    WHERE trip_id = ?1 AND currency = ?2 AND to_member = ?3), 0) AS contributed,
         COALESCE((SELECT SUM(amount_minor) FROM settlements
                    WHERE trip_id = ?1 AND currency = ?2 AND from_member = ?3), 0) AS refunded,
         COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                    JOIN expenses e ON e.id = p.expense_id
                    WHERE e.trip_id = ?1 AND e.kind = 'shared'
                      AND e.currency = ?2 AND p.member_id = ?3), 0) AS spent`,
    ).bind(trip.id, b.currency, pot.id)
      .first<{ contributed: number; refunded: number; spent: number }>();

    const remaining = (flow?.contributed ?? 0) - (flow?.spent ?? 0) - (flow?.refunded ?? 0);
    if (b.amount_minor > remaining) {
      throw createError({
        statusCode: 400,
        statusMessage: remaining <= 0
          ? `${pot.name}目前沒有可退還的${b.currency}(剩餘 ${remaining})。`
          : `退還金額 ${b.amount_minor} 超過${pot.name}剩下的 ${remaining} ${b.currency}。`
            + '退還不能超過公費手上的錢 —— 否則會憑空生出一筆債務。',
      });
    }
  }

  // ── 人對人的還款不能超過 min(付款人欠款, 收款人債權) ──────────
  //
  // 這是「結算回合」的對稱防護。回合關閉時把債務清掉,但這一支不知道那件事,
  // 所以照著已經消失的轉帳建議按下「標記已還款」會**再記一次**:
  //
  //   點結算 → 回合寫下 B→A 1,500(債務清空)
  //   手指順勢點到「標記已還款」→ 這一支又寫 B→A 1,500
  //   → 1,500 的債被記了 3,000 → App 開始叫 A 反過來付 1,500 回去給 B
  //
  // (實測 12 次併發有 1 次會走到這個順序。樂觀鎖只擋得住「還款先到」,
  //  擋不住「還款後到」—— 那必須由這一支自己守。)
  //
  // 語意上這個限制本來就該有:記一筆超過欠款的還款一定是資料錯誤,
  // 而它的後果是產生一筆反方向的假債務。
  //
  // ⚠️ 上限有**兩側**,只看付款人欠多少是不夠的 ————————————————
  //
  // 欠款只說得出「這個人總共還欠多少」,說不出「這個**收款人**還被欠多少」。
  // 兩者不一樣的時機是「債權分散在多個人身上」,而公費一旦付過共同支出就必然如此
  // (新語意下公費淨額 = +公費花費,它恆為債權人之一,見 utils/ledger.ts)。
  // 實測:公費付 ¥6,000 兩人均分、AA 墊 ¥20,000 兩人均分
  //   → 淨額 AA +7,000 / BB −13,000 / 公費 +6,000,建議只有 BB→AA ¥7,000
  //   → 直接 POST { BB→AA 13,000 }(= owes(BB))舊寫法兩道防護都放行 → 201
  //   → 之後淨額變成 AA −6,000 / 公費 +6,000:AA 憑空多出一筆 ¥6,000 的欠款,
  //     轉帳建議整個變空 —— 錢被「還」到一個沒有那麼多債權的人身上。
  // 多出來的那 6,000 本來該流向公費,而公費的腿一律不寫進 settlements
  // (那等於幫人記一筆他沒付的投入),所以它只能由使用者在總覽頁投入/退還。
  //
  // 這道縫舊語意就在,只是當時要「公費信封被超領」才走得到;淨額不含投入/退還
  // 之後它變成「只要公費付過共同支出就一直成立」—— 曝露面被上一次改動放大了。
  //
  // 加上收款人這一側不會誤擋正常流程:UI 只送 minCashFlow 的建議金額,
  // 而每一筆建議 = min(當時的 credit, −debt),天生 ≤ 兩側上限;先記掉的那些
  // 同時等量扣掉兩側,所以剩下的建議照什麼順序按都還在上限內。
  //
  // 只管人對人。投入公費(人 → 公費)不是還款,是搬現金 —— 它現在連淨額都不進
  // (見 utils/ledger.ts 開頭),拿欠款去限制它毫無意義:一個什麼都不欠的人
  // 照樣可以往信封裡放錢。公費退還則有自己的上限(上面那段)。
  const involvesPot = !!pot && (b.from_member === pot.id || b.to_member === pot.id);
  if (!involvesPot) {
    const ledger = await tripLedger(dbh, trip.id, b.currency);
    const nets = ledger.byCurrency[b.currency]?.nets ?? [];
    const netOf = (mid: string) => nets.find((n) => n.memberId === mid)?.netMinor ?? 0;
    const owes = -netOf(b.from_member);   // >0 = 付款人還欠這麼多
    const credit = netOf(b.to_member);    // >0 = 收款人還被欠這麼多
    const cap = Math.min(owes, credit);

    if (owes <= 0) {
      throw createError({
        statusCode: 409,
        statusMessage: '這筆已經結清了,不需要再記還款。'
          + '(可能剛剛的結算已經把它算進去了,請重新整理看最新狀態。)',
      });
    }
    // 收款人沒有債權 → 上限是 0,不管付款人還欠多少都不能記。
    // 這句要說得出「對象錯了」,不能只丟數字:使用者需要知道問題不是金額太大,
    // 而是這筆錢根本不該給他 —— 改小金額重試一樣是錯的。
    // 淨額 0 和淨額負數要分開講:前者是「他已經結清了」,後者是「他也在欠錢」,
    // 講錯的那一句會讓使用者去找錯的人對帳。
    if (credit <= 0) {
      throw createError({
        statusCode: 409,
        statusMessage: (credit === 0
          ? `${nameOf(b.to_member)}的帳已經結清了(淨額 0 ${b.currency}),他沒有債權可以被還。`
          : `${nameOf(b.to_member)}現在也是欠錢的一方(淨額 ${credit} ${b.currency}),`
            + '不該還錢給一個同樣欠錢的人。')
          + `記下去只會在他身上生出一筆反方向的假債務,而${nameOf(b.from_member)}`
          + '欠的錢其實一分都沒有清掉 —— 他剩下的欠款是欠別人的。'
          + '請重新整理,照最新的轉帳建議還給真正的債權人。',
      });
    }
    if (b.amount_minor > cap) {
      throw createError({
        statusCode: 409,
        statusMessage: `還款金額 ${b.amount_minor} 超過上限 ${cap} ${b.currency}`
          + `(${nameOf(b.from_member)}還欠 ${owes},${nameOf(b.to_member)}還被欠 ${credit},`
          + '上限取兩者較小的那個)。'
          + '多記的話會在收款人身上生出一筆反方向的假債務。請重新整理看最新金額。',
      });
    }
  }

  const id = uid();

  /**
   * ── 人對人還款:把上限寫進 SQL 本身 ──────────────────────────
   *
   * 上面那個 JS 檢查只是為了給出帶數字的錯誤訊息,**它擋不住併發**:
   * 讀取和寫入是兩次往返,兩支請求可以雙雙通過檢查再雙雙寫入。
   * 實測:同時點「結算」和「標記已還款」→ 兩支都 201 →
   * 1,500 的債被記了 3,000,而且墊錢的那個人反過來變成欠 1,500(6/6 命中)。
   *
   * 所以真正的防線是這個 `INSERT ... SELECT ... WHERE`:條件在寫入的
   * 同一個語句裡求值,看得到所有已提交的資料,沒有空窗。
   *
   * 上限是 **min(付款人欠款, 收款人債權)**,所以這裡有兩個 `?6 <= (...)`:
   *
   *   owes(?3)   = -net(?3) = 分攤 − 墊款 + 收到的還款 − 付出的還款
   *   credit(?4) =  net(?4) = 墊款 − 分攤 − 收到的還款 + 付出的還款
   *
   * 收款人那一側是付款人那一側的**鏡像**(每一項符號相反,member_id 換成 ?4),
   * 刻意寫成對照得出來的形狀 —— 兩塊長得不一樣的時候就是有人只改了一邊。
   * (net 的定義見 utils/settle.ts 的 netBalances;為什麼上限要看兩側,
   *  以及只看付款人時實測會生出什麼假債務,見上面 JS 那段。)
   *
   * ⚠️ 四個還款加總全都必須排掉「對方是公費」的那些列 —— 淨額不含投入/退還
   * (見 utils/ledger.ts 開頭)。這句 SQL 是上面那個 JS 檢查的資料庫層雙胞胎,
   * **兩邊算的必須是同一個上限**,否則就是這個 repo 剛修完的那一類 bug:
   * JS 放行、SQL 擋掉,使用者得到一句「這筆已經結清了」而其實沒有。
   * 具體會壞掉的流程:A 投入公費 10,000,同時欠 B 5,000(B 墊的共同支出)。
   * 新語意 owes(A) = 5,000,結算頁就是這樣建議的;舊算法是 5,000 − 10,000 = −5,000
   * → 這句 SQL 一列都插不進去 → 照著畫面按「標記已還款」永遠是 409。
   * (?8 = 公費 id,沒有公費時是 NULL,用 `?8 IS NULL OR ...` 的 sentinel 寫法 ——
   *  直接寫 `from_member <> NULL` 會求值成 NULL,把每一列都濾掉。)
   *
   * 寫不進去(changes = 0)就代表在這一瞬間其中一側已經不夠了 → 409。
   */
  const res = involvesPot
    ? await dbh.prepare(
        `INSERT INTO settlements (id, trip_id, from_member, to_member, currency, amount_minor, note)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(id, trip.id, b.from_member, b.to_member, b.currency, b.amount_minor, b.note ?? null).run()
    : await dbh.prepare(
        `INSERT INTO settlements (id, trip_id, from_member, to_member, currency, amount_minor, note)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE ?6 <= (
           COALESCE((SELECT SUM(s.amount_minor) FROM expense_shares s
                      JOIN expenses e ON e.id = s.expense_id
                      WHERE e.trip_id = ?2 AND e.kind = 'shared'
                        AND e.currency = ?5 AND s.member_id = ?3), 0)
           - COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                        JOIN expenses e ON e.id = p.expense_id
                        WHERE e.trip_id = ?2 AND e.kind = 'shared'
                          AND e.currency = ?5 AND p.member_id = ?3), 0)
           + COALESCE((SELECT SUM(amount_minor) FROM settlements
                        WHERE trip_id = ?2 AND currency = ?5 AND to_member = ?3
                          AND (?8 IS NULL OR from_member <> ?8)), 0)
           - COALESCE((SELECT SUM(amount_minor) FROM settlements
                        WHERE trip_id = ?2 AND currency = ?5 AND from_member = ?3
                          AND (?8 IS NULL OR to_member <> ?8)), 0)
         )
         AND ?6 <= (
           COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                      JOIN expenses e ON e.id = p.expense_id
                      WHERE e.trip_id = ?2 AND e.kind = 'shared'
                        AND e.currency = ?5 AND p.member_id = ?4), 0)
           - COALESCE((SELECT SUM(s.amount_minor) FROM expense_shares s
                        JOIN expenses e ON e.id = s.expense_id
                        WHERE e.trip_id = ?2 AND e.kind = 'shared'
                          AND e.currency = ?5 AND s.member_id = ?4), 0)
           + COALESCE((SELECT SUM(amount_minor) FROM settlements
                        WHERE trip_id = ?2 AND currency = ?5 AND from_member = ?4
                          AND (?8 IS NULL OR to_member <> ?8)), 0)
           - COALESCE((SELECT SUM(amount_minor) FROM settlements
                        WHERE trip_id = ?2 AND currency = ?5 AND to_member = ?4
                          AND (?8 IS NULL OR from_member <> ?8)), 0)
         )`,
      ).bind(id, trip.id, b.from_member, b.to_member, b.currency, b.amount_minor, b.note ?? null,
        pot?.id ?? null).run();

  if (!res.meta?.changes) {
    throw createError({
      statusCode: 409,
      statusMessage: '付款人的欠款或收款人的債權在你按下的這一瞬間已經不夠這筆金額了'
        + '(可能剛剛的結算把它算進去了)。什麼都沒有寫入,請重新整理看最新狀態。',
    });
  }

  setResponseStatus(event, 201);
  return {
    id,
    from_member: b.from_member,
    to_member: b.to_member,
    currency: b.currency,
    amount_minor: b.amount_minor,
  };
});
