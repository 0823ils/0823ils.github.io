// Google Apps Script Web App: TWC chat translation (LanguageApp / Google Translate)
// Deploy as Web app: Execute as "Me", access "Anyone".
// Worker should proxy requests here; don't call this URL directly from the browser.

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const text = String(body.text || "");
    const source = String(body.source || "auto");
    const target = String(body.target || "ja");
    if (!text || text.length > 5000) return out({error:"invalid_text"});
    if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(target)) return out({error:"invalid_target"});
    const translated = LanguageApp.translate(text, source === "auto" ? "" : source, target);
    return out({translation: translated});
  } catch (err) {
    return out({error:String(err && err.message || err)});
  }
}
function doGet() { return out({service:"TWC translate",ok:true}); }
function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
