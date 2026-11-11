// チャットの翻訳（ブラウザの中で動く翻訳モデル）を動かすWebワーカー。
// 画面が固まらないように、翻訳の計算は、このワーカーの中で行う。
// 翻訳はこの端末の中だけで行う。サイトのサーバーには、何も送らない。
//   ライブラリ: Transformers.js（ONNX Runtime Web）。jsDelivr から読み込む
//   モデル   : Hugging Face の Xenova/opus-mt-en-jap（英→日）と Xenova/opus-mt-jap-en（日→英）。量子化版（q8）で、1つ約100MB。
//              ダウンロードしたファイルは、ブラウザのキャッシュ（Cache API）に残り、次からは取得しない
//
// 通信の決まり:
//   画面 → ワーカー  { type: 'translate', id, dir: 'en-ja' | 'ja-en', text }
//   ワーカー → 画面  { type: 'progress', dir, p }            ダウンロードの進み具合（0〜1）
//                    { type: 'result', id, text }            訳文
//                    { type: 'error', id, message }          message: 'load'（ライブラリが取れない）/ 'download'（モデルが取れない）/ 'dir' / 'fail'

var TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
var MODELS = { 'en-ja': 'Xenova/opus-mt-en-jap', 'ja-en': 'Xenova/opus-mt-jap-en' };
var SIZE_HINT = 101e6;       // 1モデルのダウンロードの目安（バイト）。進み具合を出すためだけに使う
var MAX_NEW_TOKENS = 300;    // 訳文の長さの上限（チャットは300字まで）

var tfPromise = null;
var pipes = {};              // dir -> Promise<翻訳器>
var queue = Promise.resolve();   // 1件ずつ順番に訳す（計算を重ねない）

function post(msg) { self.postMessage(msg); }

function loadTf() {
    if (!tfPromise) {
        tfPromise = import(TF_URL).then(function(m) {
            m.env.allowLocalModels = false;   // 自分のサーバーからはモデルを配らない（Hugging Face から取る）
            m.env.useBrowserCache = true;     // 取得したファイルを、ブラウザに残す
            return m;
        }).catch(function(e) { tfPromise = null; var err = new Error('load'); err.cause = e; throw err; });
    }
    return tfPromise;
}

function getPipe(dir) {
    if (!pipes[dir]) {
        pipes[dir] = (async function() {
            var tf = await loadTf();
            var files = {}, last = -1;
            try {
                var p = await tf.pipeline('translation', MODELS[dir], {
                    dtype: 'q8',
                    device: 'wasm',
                    progress_callback: function(ev) {
                        if (!ev || ev.status !== 'progress' || !ev.file) return;
                        files[ev.file] = Number(ev.loaded) || 0;
                        var sum = 0;
                        for (var k in files) sum += files[k];
                        var frac = Math.min(0.99, sum / SIZE_HINT);   // 終わるまでは99%まで
                        if (frac - last >= 0.01) { last = frac; post({ type: 'progress', dir: dir, p: frac }); }
                    }
                });
                post({ type: 'progress', dir: dir, p: 1 });
                return p;
            } catch (e) { var err = new Error('download'); err.cause = e; throw err; }
        })().catch(function(e) { delete pipes[dir]; throw e; });
    }
    return pipes[dir];
}

async function handle(m) {
    try {
        if (!MODELS[m.dir]) throw new Error('dir');
        var text = String(m.text == null ? '' : m.text);
        var pipe = await getPipe(m.dir);
        var out = await pipe(text, { max_new_tokens: MAX_NEW_TOKENS });
        var t = Array.isArray(out) ? out[0] : out;
        post({ type: 'result', id: m.id, text: String((t && t.translation_text) || '') });
    } catch (e) {
        var msg = e && (e.message === 'load' || e.message === 'download' || e.message === 'dir') ? e.message : 'fail';
        post({ type: 'error', id: m.id, message: msg });
    }
}

self.onmessage = function(e) {
    var m = e.data;
    if (!m || m.type !== 'translate') return;
    queue = queue.then(function() { return handle(m); });
};
