/**
 * previewShares() 的單元測試 —— 記帳表單「每人分攤多少」的規則。
 *
 * 這支是為一個真實的 bug 寫的回歸測試:
 *
 *   個人花費的送出鈕被永久鎖住,完全記不了帳。
 *
 * 原因是這段規則原本埋在 ExpenseForm.vue 的 computed 裡:個人花費不經過
 * 分攤編輯器,draft 是 `{ mode:'exact', amounts:{ [owner]: null } }`,
 * 而 exact 模式會濾掉 null → preview 是 {} → 驗證判定「請選擇分攤的人」
 * → canSubmit 永遠 false。
 *
 * **56 個 API 測試全綠**,因為問題在前端、在 .vue 的 computed 裡,
 * 沒有任何測試碰得到。所以修法不只是改那行 if,而是把規則搬到
 * shared/split.ts 讓它變成可測的純函式 —— 這支就是那個測試。
 */
import { previewShares, type SplitDraft } from '../shared/split.ts';
import { toMinor } from '../shared/money.ts';
import { group, check, eq, summary } from './_harness.ts';

const A = 'aaaa', B = 'bbbb', C = 'cccc';

/** 日幣:exponent 0,人類單位 = 最小單位 */
const jpy = (v: number) => toMinor(v, 'JPY');
/** 台幣:exponent 2 */
const twd = (v: number) => toMinor(v, 'TWD');

function draft(over: Partial<SplitDraft> = {}): SplitDraft {
  return { mode: 'equal', members: [], shares: {}, amounts: {}, ...over };
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

// ═══════════════════════════════════════════════════════════════
group('[個人花費] 全額算給付款人 —— 這是 bug 的核心');

{
  // 這就是當初壞掉的那組輸入:amounts 裡是 null(使用者從沒填過分攤欄)
  const out = previewShares({
    kind: 'personal',
    amountMinor: jpy(25000),
    draft: draft({ mode: 'exact', amounts: { [A]: null } }),
    ownerId: A,
    toMinorFn: jpy,
  });
  check('amounts 是 null 時 preview 不可以是空的', Object.keys(out).length > 0, JSON.stringify(out));
  eq('全額算給付款人', out[A], 25000);
  eq('只有付款人一個人', Object.keys(out).length, 1);
  eq('合計 = 支出金額(送出鈕才會解鎖)', sum(out), jpy(25000));
}

{
  // draft 完全空的也要成立 —— 個人花費根本不該依賴 draft
  const out = previewShares({
    kind: 'personal', amountMinor: jpy(3300), draft: draft(), ownerId: A, toMinorFn: jpy,
  });
  eq('draft 空的也照樣算出來', out[A], 3300);
}

{
  // draft 裡有別人的殘留值(從共同花費切過來)不能污染個人花費
  const out = previewShares({
    kind: 'personal',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'equal', members: [A, B, C] }),
    ownerId: A,
    toMinorFn: jpy,
  });
  eq('切換 kind 的殘留 draft 不影響個人花費', Object.keys(out).length, 1);
  eq('全額還是給付款人', out[A], 1000);
}

{
  const out = previewShares({
    kind: 'personal', amountMinor: jpy(1000), draft: draft(), ownerId: undefined, toMinorFn: jpy,
  });
  eq('沒有付款人時是空的(此時該報「請選擇付款人」)', Object.keys(out).length, 0);
}

{
  // 負數:藥妝代購扣繳 -2,062(原 Excel 真的有這筆)
  const out = previewShares({
    kind: 'personal', amountMinor: twd(-2062), draft: draft(), ownerId: B, toMinorFn: twd,
  });
  eq('負數金額照樣成立', out[B], -206200);
  eq('負數合計也守恆', sum(out), twd(-2062));
}

{
  const out = previewShares({
    kind: 'personal', amountMinor: 0, draft: draft(), ownerId: A, toMinorFn: jpy,
  });
  eq('金額 0 → 空的(還沒填金額)', Object.keys(out).length, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[共同花費] 均分');

{
  const out = previewShares({
    kind: 'shared', amountMinor: jpy(13244), draft: draft({ members: [A, B] }), toMinorFn: jpy,
  });
  eq('兩人均分:合計守恆', sum(out), 13244);
  eq('13244 / 2 = 6622', out[A], 6622);
  eq('另一人也是 6622', out[B], 6622);
}

{
  // 除不盡:餘數用最大餘數法,依 id 排序給前幾位
  const out = previewShares({
    kind: 'shared', amountMinor: jpy(100), draft: draft({ members: [A, B, C] }), toMinorFn: jpy,
  });
  eq('三人分 100:合計仍是 100(不漏錢也不生錢)', sum(out), 100);
  const vals = [out[A], out[B], out[C]].sort((x, y) => x - y);
  eq('分配是 33/33/34', vals, [33, 33, 34]);
}

{
  const out = previewShares({
    kind: 'shared', amountMinor: jpy(1000), draft: draft({ members: [] }), toMinorFn: jpy,
  });
  eq('沒人分攤 → 空的(此時該報「請選擇分攤的人」)', Object.keys(out).length, 0);
}

{
  // 公費不在 members 裡 —— 公費是出錢的一方,不該替自己分攤一份
  const out = previewShares({
    kind: 'shared', amountMinor: jpy(6000), draft: draft({ members: [A, B] }), toMinorFn: jpy,
  });
  check('公費沒被算進分攤', !(('pot') in out), JSON.stringify(out));
  eq('只有兩個人分', Object.keys(out).length, 2);
  eq('各分 3000', out[A], 3000);
}

group('[共同花費] 按份數');

{
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'shares', shares: { [A]: 2, [B]: 1, [C]: 1 } }),
    toMinorFn: jpy,
  });
  eq('2:1:1 合計守恆', sum(out), 1000);
  eq('A 拿一半', out[A], 500);
  eq('B 拿四分之一', out[B], 250);
  eq('C 拿四分之一', out[C], 250);
}

{
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'shares', shares: { [A]: 1, [B]: null, [C]: 0 } }),
    toMinorFn: jpy,
  });
  eq('null 和 0 份都不列入', Object.keys(out).length, 1);
  eq('全部給有份數的那個人', out[A], 1000);
}

{
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'shares', shares: { [A]: null, [B]: null } }),
    toMinorFn: jpy,
  });
  eq('全部沒填份數 → 空的', Object.keys(out).length, 0);
}

group('[共同花費] 指定金額');

{
  // 伊藤久右衛門 6,274(民 3,857 / 喧 2,417)—— 原 Excel 寫在備註裡的那種
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(6274),
    draft: draft({ mode: 'exact', amounts: { [A]: 3857, [B]: 2417 } }),
    toMinorFn: jpy,
  });
  eq('指定金額合計守恆', sum(out), 6274);
  eq('民 3857', out[A], 3857);
  eq('喧 2417', out[B], 2417);
}

{
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'exact', amounts: { [A]: 1000, [B]: null, [C]: 0 } }),
    toMinorFn: jpy,
  });
  eq('null 和 0 都不列入這筆分攤', Object.keys(out).length, 1);
}

{
  // 台幣要換算到分 —— 這裡是 exponent 2 唯一會出錯的地方
  const out = previewShares({
    kind: 'shared',
    amountMinor: twd(100),
    draft: draft({ mode: 'exact', amounts: { [A]: 60.5, [B]: 39.5 } }),
    toMinorFn: twd,
  });
  eq('台幣換成分', out[A], 6050);
  eq('合計守恆(分)', sum(out), 10000);
}

{
  // 對不上的時候要照實回報,不要偷偷補平 —— 表單靠這個差額顯示警告
  const out = previewShares({
    kind: 'shared',
    amountMinor: jpy(1000),
    draft: draft({ mode: 'exact', amounts: { [A]: 400, [B]: 400 } }),
    toMinorFn: jpy,
  });
  eq('合計 800 就是 800,不自動補平', sum(out), 800);
}

process.exit(summary() > 0 ? 1 : 0);
