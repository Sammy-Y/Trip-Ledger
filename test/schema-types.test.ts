/**
 * schema.sql 與 shared/types.ts 的一致性測試。
 *
 * 為什麼需要這支:資料表定義在 schema.sql,TypeScript 型別在 shared/types.ts,
 * 兩份是「手工同步」的。加欄位時忘記改型別,編譯器不會抱怨 ——
 * 因為 D1 的 .first<T>() 只是把回傳值斷言成 T,不做任何實際驗證。
 *
 * 這正是 ORM(Drizzle)會從結構上消滅的問題。在還沒換 ORM 之前,用測試守。
 */
import { readFileSync } from 'node:fs';
import { group, check, summary } from './_harness.ts';

const sql = readFileSync('schema.sql', 'utf8');
const types = readFileSync('shared/types.ts', 'utf8');

/** 從 CREATE TABLE 抽出欄位名 */
function columnsOf(table: string): string[] {
  const m = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'));
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--')
      && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l))
    .map((l) => l.split(/[\s(]/)[0])
    .filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c));
}

/**
 * 從 interface 抽出屬性名。
 * 要處理兩件事,否則會抓錯:
 *   1. 一行多個欄位(`id: string; kind: Kind; description: string;`)
 *   2. 巢狀物件型別(`payers: Array<{ member_id: string }>`)—— 內層的
 *      member_id 不是這個 interface 的欄位,必須先把巢狀括號整段挖掉
 */
function fieldsOf(iface: string): string[] {
  const at = types.indexOf(`interface ${iface}`);
  if (at < 0) return [];
  const open = types.indexOf('{', at);
  if (open < 0) return [];

  // 用括號配對找出 interface 本體的範圍
  let depth = 0, close = -1;
  for (let i = open; i < types.length; i++) {
    if (types[i] === '{') depth++;
    else if (types[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return [];
  let body = types.slice(open + 1, close);

  // 反覆挖掉最內層的 {...},直到沒有巢狀
  let prev: string;
  do { prev = body; body = body.replace(/\{[^{}]*\}/g, ''); } while (body !== prev);

  // 一行多欄位:先照 ; 和換行切開,再各自抓 `name:` 或 `name?:`
  return body.split(/[;\n]/)
    .map((frag) => frag.trim())
    .filter(Boolean)
    .map((frag) => frag.match(/^(\w+)\s*\??\s*:/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]);
}

group('[結構] schema.sql 能被解析');
const tables = ['trips', 'members', 'expenses', 'reservations', 'settlements', 'fx_rates',
  'fx_exchanges'];
for (const t of tables) {
  const cols = columnsOf(t);
  check(`${t} 解析出欄位 (${cols.length})`, cols.length > 2, cols.join(','));
}

group('[一致性] TS 型別的欄位必須真的存在於資料表');
// 型別裡有、但資料表沒有的欄位 → 查詢一定回 undefined,是靜默的 bug
const pairs: Array<[string, string, string[]]> = [
  ['Trip', 'trips', []],
  ['Member', 'members', []],
  // Expense 多了 payers / shares 兩個組裝出來的陣列,不是資料表欄位
  ['Expense', 'expenses', ['payers', 'shares']],
  ['Reservation', 'reservations', []],
  // FxExchange 刻意沒有 rate 欄位 —— 匯率是導出值(見 schema.sql 的 fx_exchanges)
  ['FxExchange', 'fx_exchanges', []],
];
for (const [iface, table, extra] of pairs) {
  const cols = new Set(columnsOf(table));
  const fields = fieldsOf(iface).filter((f) => !extra.includes(f));
  const missing = fields.filter((f) => !cols.has(f));
  check(`${iface} 的欄位都存在於 ${table}`, missing.length === 0,
    missing.length ? `型別有但資料表沒有: ${missing.join(', ')}` : '');
}

group('[覆蓋率] 資料表的重要欄位不該在型別裡缺漏');
// 反方向:資料表有、型別沒有 → 前端拿不到那個欄位,功能會悄悄少一塊
{
  const cols = columnsOf('expenses');
  const fields = new Set(fieldsOf('Expense'));
  const uncovered = cols.filter((c) => !fields.has(c) && c !== 'trip_id');
  check('Expense 型別覆蓋 expenses 所有欄位', uncovered.length === 0,
    uncovered.length ? `資料表有但型別沒有: ${uncovered.join(', ')}` : '');
}
{
  const cols = columnsOf('reservations');
  const fields = new Set(fieldsOf('Reservation'));
  const uncovered = cols.filter((c) => !fields.has(c) && c !== 'trip_id');
  check('Reservation 型別覆蓋 reservations 所有欄位', uncovered.length === 0,
    uncovered.length ? `資料表有但型別沒有: ${uncovered.join(', ')}` : '');
}
{
  const cols = columnsOf('fx_exchanges');
  const fields = new Set(fieldsOf('FxExchange'));
  const uncovered = cols.filter((c) => !fields.has(c) && c !== 'trip_id');
  check('FxExchange 型別覆蓋 fx_exchanges 所有欄位', uncovered.length === 0,
    uncovered.length ? `資料表有但型別沒有: ${uncovered.join(', ')}` : '');
}

group('[不變量] 金額欄位一律是整數最小單位');
check('expenses.amount_minor 是 INTEGER',
  /amount_minor\s+INTEGER/i.test(sql));
check('沒有任何 REAL 型別的金額欄位（浮點數存錢是災難）',
  !/amount\w*\s+REAL/i.test(sql));
check('fx_rate 才可以是 REAL（匯率不是金額）',
  /fx_rate\s+REAL/i.test(sql));

group('[不變量] 換匯存的是兩邊的金額，不是匯率');
// 存 rate 的話金額要由浮點數反推，而加權平均會從 0.2067 變成 0.2075
// （完整推導見 schema.sql 的 fx_exchanges）。這條守的是那個設計決定本身。
{
  const cols = columnsOf('fx_exchanges');
  check('fx_exchanges 有 amount_minor 與 cost_minor 兩個整數欄位',
    cols.includes('amount_minor') && cols.includes('cost_minor')
    && /amount_minor\s+INTEGER/i.test(sql) && /cost_minor\s+INTEGER/i.test(sql));
  check('fx_exchanges 沒有 rate 欄位（匯率是導出值）',
    !cols.some((c) => /rate/i.test(c)), cols.filter((c) => /rate/i.test(c)).join(','));
  check('換到的與付出的幣別不可相同（同幣別沒有匯率可言）',
    /CHECK\s*\(\s*currency\s*<>\s*cost_currency\s*\)/i.test(sql));
}

process.exit(summary() > 0 ? 1 : 0);
