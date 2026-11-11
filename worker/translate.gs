// ===== scratch-TWC チャット翻訳用 Google Apps Script =====
// Worker（/api/chat/translate）から呼ばれて、Google翻訳（LanguageApp）で訳した文章を返す。
//   ・合言葉（スクリプトのプロパティ TWC_SECRET）が合わないリクエストは、断る
//   ・日本語 ⇄ 英語だけ。1回に20件まで、1件1000文字まで
//   ・無料枠: 翻訳の呼び出し 1日5,000回まで（個人のGoogleアカウントの場合。Googleの都合で変わることがある）

var MAX_TEXTS = 20;
var MAX_LEN = 1000;

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('TWC_SECRET');
    if (!secret || req.secret !== secret) return out_({ ok: false, error: 'forbidden' });
    if (req.to !== 'ja' && req.to !== 'en') return out_({ ok: false, error: 'bad_lang' });
    var texts = req.texts;
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS) return out_({ ok: false, error: 'bad_texts' });
    var result = texts.map(function (s) {
      s = String(s).slice(0, MAX_LEN);
      if (!s.trim()) return s;
      return decode_(LanguageApp.translate(s, '', req.to));   // 元の言語は、自動で判定する
    });
    return out_({ ok: true, texts: result });
  } catch (err) {
    var msg = String((err && err.message) || err);
    return out_({ ok: false, error: /too many times|quota|limit|exceeded/i.test(msg) ? 'quota' : 'error' });
  }
}

// ブラウザで開いたときは、何も教えない
function doGet() {
  return out_({ ok: false, error: 'post_only' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// LanguageApp は、&#39; や &quot; のような HTML の記号で返すことがあるので、元の文字に戻す
function decode_(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ★ 最初に1回だけ、エディタでこの関数を「実行」して、権限を許可する。ログに訳文が出れば成功
function testOnce() {
  Logger.log(decode_(LanguageApp.translate('Hello, it\'s a nice day!', '', 'ja')));
  Logger.log(decode_(LanguageApp.translate('今日はいい天気ですね', '', 'en')));
}
