// 通知用の鍵（VAPID）を作る。使い方:
//   cd worker && node gen_vapid.mjs | npx wrangler secret put VAPID_PRIVATE_JWK
// 画面には何も出さず、そのまま Worker のシークレットに登録する。
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
process.stdout.write(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }));
