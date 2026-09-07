/**
 * 產生 PWA / favicon 圖示。
 *
 * 為什麼要有這支:專案沒有裝 ImageMagick 或 Pillow,而 icon 又必須是真的 PNG
 * (manifest 和 Web Push 都不吃 SVG)。這裡直接用 zlib 寫 PNG,零依賴。
 * 留在 repo 裡是為了讓圖示可重現 —— 要改配色或形狀就改這裡再跑一次,
 * 而不是在某個設計工具裡改完丟一個沒人知道怎麼來的二進位檔進來。
 *
 *   node scripts/gen-icons.mjs
 *
 * 設計:圓角方形品牌底色 + 白色「被切開的圓」。
 * 圓被一條斜線分成兩塊、兩塊亮度不同 —— 這正是這個 App 在做的事:
 * 一筆錢分成不相等的兩份。幾何圖形在 16px 的 favicon 也還讀得出來。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── PNG 編碼 ────────────────────────────────────────────────
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8ClampedArray,長度 = w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  // 每一列前面要加 filter type byte(0 = None)
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 色彩:main.css 的 --brand 是 oklch,這裡轉成 sRGB ────────
function oklchToRgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  });
}

// --brand: oklch(0.55 0.16 250) —— 和 UI 同一個藍
const BRAND = oklchToRgb(0.55, 0.16, 250);
// 底色做一點漸層,平面色在大尺寸下太死
const BRAND_TOP = oklchToRgb(0.62, 0.17, 255);

// ── 繪製 ────────────────────────────────────────────────────
/**
 * @param size    輸出邊長
 * @param inset   圖形內縮比例。maskable 圖示要留安全區(Android 會裁成圓形)
 * @param bleed   true = 底色滿版(maskable),false = 圓角方形
 */
function draw(size, { inset = 0, bleed = false } = {}) {
  const SS = 4;                     // 超取樣倍率,用來做反鋸齒
  const S = size * SS;
  const px = new Uint8ClampedArray(size * size * 4);
  const acc = new Float32Array(size * size * 4);

  const pad = S * inset;
  const box = { x0: pad, y0: pad, x1: S - pad, y1: S - pad };
  const boxW = box.x1 - box.x0;
  const radius = bleed ? 0 : boxW * 0.235;   // iOS/Android 慣用的圓角比例

  const cx = S / 2, cy = S / 2;
  const R = boxW * 0.29;                     // 主圓半徑
  const stroke = boxW * 0.085;               // 圓環粗細
  // 分割線:從左下到右上,和「轉帳」的方向感一致
  const ang = -35 * Math.PI / 180;
  const nx = Math.sin(ang), ny = -Math.cos(ang);   // 分割線法向量
  const gap = boxW * 0.021;                        // 兩塊之間的縫隙

  const inBox = (x, y) => {
    if (bleed) return true;
    const dx = Math.max(box.x0 + radius - x, 0, x - (box.x1 - radius));
    const dy = Math.max(box.y0 + radius - y, 0, y - (box.y1 - radius));
    return dx * dx + dy * dy <= radius * radius
      || (x >= box.x0 && x <= box.x1 && y >= box.y0 + radius && y <= box.y1 - radius)
      || (y >= box.y0 && y <= box.y1 && x >= box.x0 + radius && x <= box.x1 - radius);
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inBox(x + 0.5, y + 0.5)) continue;

      // 背景漸層(左上亮 → 右下深)
      const t = (x / S) * 0.35 + (y / S) * 0.65;
      let r = BRAND_TOP[0] + (BRAND[0] - BRAND_TOP[0]) * t;
      let g = BRAND_TOP[1] + (BRAND[1] - BRAND_TOP[1]) * t;
      let b = BRAND_TOP[2] + (BRAND[2] - BRAND_TOP[2]) * t;

      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const side = dx * nx + dy * ny;          // >0 = 分割線的一側

      // 圓環本體,並在分割線兩側留縫
      const onRing = Math.abs(dist - R) <= stroke / 2 && Math.abs(side) > gap;
      // 其中一側的扇形填實 —— 表示「這一份比較多」,也就是不均分
      const inWedge = dist < R - stroke / 2 - gap * 0.6 && side > gap;

      if (onRing || inWedge) {
        const alpha = inWedge && !onRing ? 0.82 : 1;   // 填實那塊稍微透一點,才有層次
        r = r + (255 - r) * alpha;
        g = g + (255 - g) * alpha;
        b = b + (255 - b) * alpha;
      }

      // 累加到降取樣後的像素
      const ox = (x / SS) | 0, oy = (y / SS) | 0;
      const i = (oy * size + ox) * 4;
      acc[i] += r; acc[i + 1] += g; acc[i + 2] += b; acc[i + 3] += 255;
    }
  }

  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    // 有覆蓋到的地方才算色彩平均，否則邊緣會被黑色拉暗
    const cov = a / 255 || 1;
    px[i * 4] = acc[i * 4] / n / cov;
    px[i * 4 + 1] = acc[i * 4 + 1] / n / cov;
    px[i * 4 + 2] = acc[i * 4 + 2] / n / cov;
    px[i * 4 + 3] = a;
  }
  return encodePng(size, size, px);
}

mkdirSync('public', { recursive: true });

const outputs = [
  ['public/icon-192.png',           draw(192)],
  ['public/icon-512.png',           draw(512)],
  // maskable:Android 會把圖示裁成圓角/圓形,圖形必須落在中央 80% 的安全區內
  ['public/icon-maskable-512.png',  draw(512, { inset: 0.10, bleed: true })],
  ['public/apple-touch-icon.png',   draw(180)],
  ['public/favicon-32.png',         draw(32)],
  ['public/favicon-16.png',         draw(16)],
];

for (const [path, buf] of outputs) {
  writeFileSync(path, buf);
  console.log(`  ${path.padEnd(34)} ${String(buf.length).padStart(7)} bytes`);
}
console.log('\n改配色或形狀就改這支再跑一次。');
