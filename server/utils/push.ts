/**
 * Web Push(VAPID)。
 *
 * 刻意送「不帶 payload」的空推播:有 payload 就得實作 aes128gcm 加密,
 * 空推播只需要 VAPID 簽章。Service Worker 收到後自己回打 API 取內容 ——
 * 少掉一整套加密程式碼,行程細節也不會經過第三方推播服務。
 */
export type VapidConfig = { privateJwk: string; publicKey: string; subject: string };

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function vapidJwt(cfg: VapidConfig, audience: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: cfg.subject || 'mailto:admin@example.com',
  };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;

  const key = await crypto.subtle.importKey(
    'jwk', JSON.parse(cfg.privateJwk),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

/** 回傳 'sent' | 'gone'(訂閱失效,呼叫端應刪除)| 'error' */
export async function sendEmptyPush(cfg: VapidConfig, endpoint: string): Promise<'sent' | 'gone' | 'error'> {
  if (!cfg.privateJwk || !cfg.publicKey) return 'error';
  const jwt = await vapidJwt(cfg, new URL(endpoint).origin);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600',
      Authorization: `vapid t=${jwt}, k=${cfg.publicKey}`,
      'Content-Length': '0',
    },
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'sent' : 'error';
}
