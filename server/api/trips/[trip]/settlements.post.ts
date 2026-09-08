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
    dbh.prepare(`SELECT id FROM members WHERE trip_id = ? AND id IN (?, ?)`)
      .bind(trip.id, b.from_member, b.to_member).all<{ id: string }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(b.currency).first<{ code: string }>(),
  ]);

  // 兩個人都得在這趟旅程裡。少一個就代表 id 打錯或屬於別的旅程。
  if ((members.results ?? []).length !== 2) {
    throw createError({ statusCode: 400, statusMessage: '付款人或收款人不屬於這趟旅程' });
  }
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

  // ── 人對人的還款不能超過目前的欠款 ──────────────────────────
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
  // 只管人對人。投入公費(人 → 公費)不是還款,是搬現金,淨額可能是正的,
  // 不能用欠款去限制它;公費退還已經有自己的上限。
  const involvesPot = !!pot && (b.from_member === pot.id || b.to_member === pot.id);
  if (!involvesPot) {
    const ledger = await tripLedger(dbh, trip.id, b.currency);
    const net = ledger.byCurrency[b.currency]?.nets
      .find((n) => n.memberId === b.from_member)?.netMinor ?? 0;
    const owes = -net;   // >0 = 這個人還欠這麼多

    if (owes <= 0) {
      throw createError({
        statusCode: 409,
        statusMessage: '這筆已經結清了,不需要再記還款。'
          + '(可能剛剛的結算已經把它算進去了,請重新整理看最新狀態。)',
      });
    }
    if (b.amount_minor > owes) {
      throw createError({
        statusCode: 409,
        statusMessage: `還款金額 ${b.amount_minor} 超過目前的欠款 ${owes} ${b.currency}。`
          + '多記的話會產生一筆反方向的假債務。請重新整理看最新金額。',
      });
    }
  }

  const id = uid();

  /**
   * ── 人對人還款:把「不能超過欠款」寫進 SQL 本身 ──────────────
   *
   * 上面那個 JS 檢查只是為了給出帶數字的錯誤訊息,**它擋不住併發**:
   * 讀取和寫入是兩次往返,兩支請求可以雙雙通過檢查再雙雙寫入。
   * 實測:同時點「結算」和「標記已還款」→ 兩支都 201 →
   * 1,500 的債被記了 3,000,而且墊錢的那個人反過來變成欠 1,500(6/6 命中)。
   *
   * 所以真正的防線是這個 `INSERT ... SELECT ... WHERE`:條件在寫入的
   * 同一個語句裡求值,看得到所有已提交的資料,沒有空窗。
   *
   * owes = -net = 分攤 − 墊款 + 收到的還款 − 付出的還款
   * (net 的定義見 utils/settle.ts 的 netBalances)
   *
   * 寫不進去(changes = 0)就代表在這一瞬間債務已經被清掉了 → 409。
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
                        WHERE trip_id = ?2 AND currency = ?5 AND to_member = ?3), 0)
           - COALESCE((SELECT SUM(amount_minor) FROM settlements
                        WHERE trip_id = ?2 AND currency = ?5 AND from_member = ?3), 0)
         )`,
      ).bind(id, trip.id, b.from_member, b.to_member, b.currency, b.amount_minor, b.note ?? null).run();

  if (!res.meta?.changes) {
    throw createError({
      statusCode: 409,
      statusMessage: '這筆債務在你按下的這一瞬間已經被結清了(可能剛剛的結算把它算進去了)。'
        + '什麼都沒有寫入,請重新整理看最新狀態。',
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
