/**
 * 「再記一筆」的欄位契約 —— 連續記帳時哪些欄位留著、哪些清掉。
 *
 * ══ 為什麼需要這一支 ═══════════════════════════════════════════
 *
 * ExpenseForm.startNextEntry() 決定了送出成功之後表單長什麼樣子。
 * 它會壞的方式**不是**寫錯,而是**沒跟上**:有人加了一個新欄位
 * (例如「小費 %」),忘了決定它要不要清 —— 於是上一筆的值靜靜掛到下一筆上,
 * 而使用者只會檢查自己剛打的那一格。
 *
 * 那種 bug 沒有任何既有測試照得到:
 *   - API 測試看不到 .vue 的 ref(這個 repo 已經因為同樣的理由漏過一次 ——
 *     見 shared/split.ts 的 previewShares 註解,那個 bug 在 56 個 API 測試
 *     全綠的情況下活著)
 *   - vue-compile 只驗編得過
 *   - 型別檢查對「少清一個欄位」沒有任何意見
 *
 * 所以這支用**原始碼**比對:把 ExpenseForm 頂層宣告的每一個表單 ref
 * 抓出來,要求它要嘛出現在 startNextEntry() 裡(清掉),要嘛出現在下面的
 * STICKY 名單裡(刻意留著)。兩邊都沒有 → 紅。加新欄位的人被迫做這個決定,
 * 而且那個決定會留在這個檔案裡給下一個人看。
 */
import { readFileSync } from 'node:fs';
import { group, check, eq, summary } from './_harness.ts';

const src = readFileSync(new URL('../app/components/expense/ExpenseForm.vue', import.meta.url), 'utf8');

/**
 * 送出後**刻意保留**的欄位 —— 「現在在什麼情境記帳」。
 *
 * 在京都的居酒屋連記三筆,幣別、日期、誰付的、幾個人分,三次都一樣。
 * 每記一筆就重設一次,等於逼使用者把同樣的東西再點三遍 ——
 * 那正是連續記帳這個功能要解決的問題。
 * (使用者明確要求過「幣別不用回預設值」。)
 */
const STICKY = new Set([
  'kind',           // 共同 / 個人
  'currency',       // ← 使用者點名的那一個
  'paymentMethod',  // 現金 / 刷卡
  'spentAt',        // 同一天的帳通常一起記
  'payers',         // 常常是同一個人連付好幾筆
  'split',          // 同一群人
  'fromPot',        // 從公費付的通常不只一筆
  'markupInput',    // 跟著幣別 + 付款方式走,那兩個留著它就該留著
  'markupTouched',  // 同上:使用者自訂過的加成不該被下一筆偷偷改回預設
]);

/** 不是表單欄位,是元件自己的機關 —— 不參與這個契約。 */
const NOT_A_FIELD = new Set([
  'descriptionField',  // template ref(focus 用)
]);

// ═══════════════════════════════════════════════════════════════
group('[再記一筆] 每個表單欄位都要明確決定「清掉」還是「留著」');

const bodyMatch = src.match(/function startNextEntry\(\): void \{([\s\S]*?)\n\}/);
check('找得到 startNextEntry()', !!bodyMatch,
  'ExpenseForm 的 startNextEntry 不見了或簽章變了 —— 連續記帳的重設邏輯沒有人守了');
const body = bodyMatch?.[1] ?? '';

// 頂層的 `const x = ref(...)`。縮排過的(函式內部的)不算。
const declared = [...src.matchAll(/^const (\w+) = ref[<(]/gm)].map((m) => m[1]!);
check(`抓到 ${declared.length} 個頂層 ref`, declared.length >= 15, JSON.stringify(declared));

const unaccounted: string[] = [];
for (const name of declared) {
  if (NOT_A_FIELD.has(name)) continue;
  const cleared = new RegExp(`\\b${name}\\.value\\s*=`).test(body);
  if (cleared === STICKY.has(name)) {
    unaccounted.push(cleared
      ? `${name}:在 STICKY 名單裡卻被 startNextEntry 清掉了`
      : `${name}:既沒被清掉,也不在 STICKY 名單裡`);
  }
}
eq('沒有欄位漏掉決定', unaccounted, []);

// ── 逐條釘住幾個「絕對不能留」的 ────────────────────────────────
// 這幾個不只是「最好清掉」,留著會直接產生錯的帳:
group('[再記一筆] 這幾個留著會記出錯的帳');

const MUST_CLEAR: Array<[string, string]> = [
  ['description', '上一筆的說明掛到下一筆,而使用者只會看金額'],
  ['amountInput', '上一筆的金額掛到下一筆 —— 最直接的記錯錢'],
  ['category', '分類是「這一筆是什麼」,和說明同一類'],
  ['note', '同上'],
  ['fxOverride', '照某一張信用卡帳單填的匯率套到下一筆,是一個沒人會發現的錯誤換算'],
];
for (const [name, why] of MUST_CLEAR) {
  check(`清掉 ${name} —— ${why}`,
    new RegExp(`\\b${name}\\.value\\s*=`).test(body), body.slice(0, 400));
}

check('使用者點名的「幣別不回預設值」有被守住',
  STICKY.has('currency') && !/\bcurrency\.value\s*=/.test(body),
  'startNextEntry 動到了 currency');

// ── 接線:頁面要真的叫得到它 ────────────────────────────────────
group('[再記一筆] 頁面與元件的接線');

check('ExpenseForm 有 defineExpose({ startNextEntry })',
  /defineExpose\(\{\s*startNextEntry\s*\}\)/.test(src));
check('說明欄有掛 ref,focus 才找得到它',
  /ref="descriptionField"/.test(src));

const page = readFileSync(new URL('../app/pages/t/[trip]/new.vue', import.meta.url), 'utf8');
check('記一筆那頁有呼叫 startNextEntry()', /startNextEntry\(\)/.test(page));
check('記一筆那頁不再自動跳走(沒有 navigateTo 到列表)',
  !/setTimeout\([^)]*navigateTo/.test(page) && !/navigateTo\(`\/t\/\$\{[^}]*\}`\)/.test(page),
  '送出後又自動導航了 —— 連續記帳會被打斷');
check('表單有掛 ref,頁面才叫得到 startNextEntry', /ref="form"/.test(page));

process.exit(summary() > 0 ? 1 : 0);
