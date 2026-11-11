#!/bin/bash
# 端末への通知（Web Push）の鍵を作って、設定する。1回だけ実行する。
#   秘密鍵: Cloudflare の Secret（VAPID_PRIVATE_KEY）に直接入れる（画面には出さない）
#   公開鍵: wrangler.toml の VAPID_PUBLIC_KEY に書き込む
set -e
cd "$(dirname "$0")"
if grep -q '^VAPID_PUBLIC_KEY = "[^"][^"]*"' wrangler.toml; then
  echo "すでに公開鍵が設定されています。作り直すと、登録済みの端末への通知が止まるので、中止します。"
  echo "作り直すときは、wrangler.toml の VAPID_PUBLIC_KEY を空（\"\"）にしてから、もう一度実行してください。"
  exit 1
fi
KEYS=$(node -e "
const c = require('crypto');
const k = c.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const j = k.privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
console.log(pub + ' ' + j.d);
")
PUB=${KEYS% *}
PRIV=${KEYS#* }
printf '%s' "$PRIV" | npx wrangler secret put VAPID_PRIVATE_KEY
python3 -c "
import re, sys
p = 'wrangler.toml'
s = open(p, encoding='utf-8').read()
s, n = re.subn(r'^VAPID_PUBLIC_KEY = .*\$', 'VAPID_PUBLIC_KEY = \"%s\"' % sys.argv[1], s, flags=re.M)
if n != 1: sys.exit('wrangler.toml に VAPID_PUBLIC_KEY の行がありません')
open(p, 'w', encoding='utf-8').write(s)
" "$PUB"
echo "OK: 鍵を設定しました。続けて、npx wrangler deploy を実行してください。"
