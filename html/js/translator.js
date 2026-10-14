/* ============================================================
 * translator.js —— 翻译域逻辑（自旧版 index.html 移植并整理）
 * 语言表 / 语种自动识别 / 通道与模型路由 / 提示词构建（含术语干预）
 * ============================================================ */

export const LANGS = [
  ['zh','中文','Chinese'],['en','英语','English'],['ja','日语','Japanese'],['ko','韩语','Korean'],
  ['fr','法语','French'],['de','德语','German'],['ru','俄语','Russian'],['es','西班牙语','Spanish'],
  ['pt','葡萄牙语','Portuguese'],['it','意大利语','Italian'],['ar','阿拉伯语','Arabic'],['th','泰语','Thai'],
  ['vi','越南语','Vietnamese'],['ms','马来语','Malay'],['id','印尼语','Indonesian'],['tl','菲律宾语','Filipino'],
  ['hi','印地语','Hindi'],['zh-Hant','繁体中文','Traditional Chinese'],['pl','波兰语','Polish'],['cs','捷克语','Czech'],
  ['nl','荷兰语','Dutch'],['km','高棉语','Khmer'],['my','缅甸语','Burmese'],['fa','波斯语','Persian'],
  ['gu','古吉拉特语','Gujarati'],['ur','乌尔都语','Urdu'],['te','泰卢固语','Telugu'],['mr','马拉地语','Marathi'],
  ['he','希伯来语','Hebrew'],['bn','孟加拉语','Bengali'],['ta','泰米尔语','Tamil'],['uk','乌克兰语','Ukrainian'],
  ['bo','藏语','Tibetan'],['kk','哈萨克语','Kazakh'],['mn','蒙古语','Mongolian'],['ug','维吾尔语','Uyghur'],
  ['yue','粤语','Cantonese'],['tr','土耳其语','Turkish']
];

/* 模型通道：本地统一 qwen3.5:9b；num_gpu=null 让 Ollama 自行决定 4GB 显存的部分卸载 */
export const CHANNELS = {
  fast:    { model: 'qwen3.5:9b', label: 'Qwen3.5 9B 标准', keep: '10m' },
  quality: { model: 'qwen3.5:9b', label: 'Qwen3.5 9B 长文', keep: '5m'  },
};
export const OPTS = { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05, num_ctx: 4096, num_predict: 2048 };
export const LONG_THRESHOLD = 1500;

export function nameOf(code, lang = 'zh') {
  if (code === 'auto') return lang === 'zh' ? '自动识别' : 'Auto-detect';
  const f = LANGS.find(l => l[0] === code);
  if (!f) return 'Chinese';
  return lang === 'zh' ? f[1] : (code === 'zh' ? '中文' : f[2]);
}
export function langFamily(code) { return (code === 'zh' || code === 'zh-Hant') ? 'zh' : code; }

/* ---------------- 语种自动识别（本地启发式，文本不出本机） ---------------- */
const TRAD_CHARS = '們國會時來說東兩個這麼還與後處點對開關馬魚鳥車學體產當發過長門問間題實為監視應開發電腦網絡資訊語話該詳細讓歷經濟參與聯繫願會員專業點擊進入選擇種類確認購買訂單產品服務系統功能帳號密碼驗證';
function isTraditional(t) { for (const c of TRAD_CHARS) if (t.includes(c)) return true; return false; }

const LATIN_STOP = {
  en:new Set(['the','and','is','in','to','of','a','for','on','with','as','was','that','at','by','are','you','this','be','it','he','she','we','they','have','has','not','but','his','her','an','or','i']),
  es:new Set(['el','la','que','de','y','en','un','ser','se','no','por','con','su','para','como','los','una','del','las','es','este','son','muy','pero','mas','fue']),
  fr:new Set(['le','la','les','de','et','un','une','que','est','en','qui','pour','pas','avec','ce','vous','je','tu','il','elle','nous','ils','etre','avoir','mais','sur','dans','plus','mon','son']),
  de:new Set(['der','die','das','und','ist','in','den','von','zu','mit','sich','auf','fur','nicht','ein','ich','du','er','sie','wir','sein','haben','werden','auch','als','an','nach','wird','es','wie','geht','sind']),
  pt:new Set(['o','a','que','de','e','do','da','em','um','para','com','como','nao','uma','os','no','dos','das','voce','foi','mais','mas','seu','sua','esta','sao']),
  it:new Set(['il','la','che','di','e','a','da','un','per','in','con','del','non','le','si','come','uno','una','sono','qui','loro','ma','anche','fare','poi','e','sto']),
  nl:new Set(['de','het','een','en','van','ik','te','dat','die','is','op','aan','met','niet','zijn','voor','maar','ook','wordt','als','dan','naar','hebben','je','we','wat','dit']),
  pl:new Set(['jest','ze','co','jak','nie','sie','ale','tak','ono','one','ich','gdy','przy','tylko','bardzo','poniewaz','przez']),
  tr:new Set(['icin','ne','her','bir','var','de','da','cok','guzel','kadar','olarak','sen','biz','onlar','degil','ama','merhaba','nasilsin','tesekkur','evet','hayir','nasil']),
  vi:new Set(['va','cua','toi','la','mot','co','de','trong','voi','nay','do','khong','nhung','nguoi','khi','anh','chi','em','cac','duoc','ve','tai','nhu','hay','hoac'])
};
function detectLatin(text) {
  const toks = (text.toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i')
    .match(/[a-z]+/g) || []);
  if (!toks.length) return 'en';
  let best = 'en', bestN = 0;
  for (const lang in LATIN_STOP) {
    let n = 0;
    for (const w of toks) if (LATIN_STOP[lang].has(w)) n++;
    if (n > bestN) { bestN = n; best = lang; }
  }
  return best;
}
function detectCyrillic(text) { return /[іїєґІЇЄҐ]/.test(text) ? 'uk' : 'ru'; }
function detectArabic(text) { return /[پچژگ]/.test(text) ? 'fa' : (/[ٹڈڑۂۓ]/.test(text) ? 'ur' : 'ar'); }

export function detectLang(text) {
  const s = (text || '').replace(/\s+/g, '');
  if (!s) return 'en';
  let cjk = 0, bopo = 0, hira = 0, kata = 0, hang = 0, cyr = 0, arab = 0, dev = 0, thai = 0, latin = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x309F) hira++;
    else if (c >= 0x30A0 && c <= 0x30FF) kata++;
    else if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F)) hang++;
    else if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
    else if (c >= 0x3400 && c <= 0x4DBF) cjk++;
    else if (c >= 0x3100 && c <= 0x312F) bopo++;
    else if (c >= 0x0400 && c <= 0x04FF) cyr++;
    else if (c >= 0x0600 && c <= 0x06FF) arab++;
    else if (c >= 0x0900 && c <= 0x097F) dev++;
    else if (c >= 0x0E00 && c <= 0x0E7F) thai++;
    else if ((c >= 0x0041 && c <= 0x007A) || (c >= 0x00C0 && c <= 0x024F) || (c >= 0x1E00 && c <= 0x1EFF)) latin++;
  }
  if (hira || kata) return 'ja';
  if (hang) return 'ko';
  if (cjk >= 3 || ((cjk + bopo) > 0 && (cjk + bopo) >= latin * 0.6))
    return isTraditional(text) ? 'zh-Hant' : 'zh';
  if (cyr) return detectCyrillic(text);
  if (arab) return detectArabic(text);
  if (dev) return 'hi';
  if (thai) return 'th';
  if (latin > 0) return detectLatin(text);
  return 'en';
}

/* 源=auto 时自动识别；识别结果与目标同族时自动翻转（默认译中文） */
export function resolveLangs(text, srcSel, tgtSel) {
  let src = srcSel, tgt = tgtSel, note = '';
  if (src === 'auto') {
    if (!text.trim()) return { src: 'auto', tgt, note: '自动识别' };
    const det = detectLang(text);
    src = det;
    if (langFamily(det) === langFamily(tgt)) {
      tgt = (langFamily(tgt) === 'zh') ? 'en' : 'zh';
      note = '原文检测为' + nameOf(det) + '，已自动转译' + nameOf(tgt);
    } else {
      note = '自动识别 ' + nameOf(det) + ' → ' + nameOf(tgt);
    }
  }
  return { src, tgt, note };
}

/* ---------------- 术语干预 & Prompt ---------------- */
export function termPrefix(terms) {
  if (!terms || !terms.length) return '';
  return '参考下面的翻译:\n' + terms.map(t => t.src + ' 翻译成 ' + t.dst).join('\n') + '\n';
}

export function buildPrompt(text, src, tgt, terms) {
  const head = termPrefix(terms);
  if (src === 'zh' || tgt === 'zh')
    return head + '将以下文本翻译为' + nameOf(tgt) + '，注意只需要输出翻译后的结果，不要额外解释：\n\n' + text;
  return head + 'Translate the following segment into ' + nameOf(tgt, 'en') +
         ', without additional explanation.\n\n' + text;
}

/* ---------------- 离线词典快路径 ----------------
 * 已内置多语种开源词典（CC-CEDICT 中⇄英、FreeDict 日/法/西/葡/荷/德/意⇄英等）。
 * 单词/短语先查离线词典，命中即秒回，不调用模型；未命中再走模型。
 */
export const DICT_PAIRS = {
  'zh-en': { src: 'zh', tgt: 'en' },
  'en-zh': { src: 'en', tgt: 'zh' },
  'ja-en': { src: 'ja', tgt: 'en' },
  'en-ja': { src: 'en', tgt: 'ja' },
  'fr-en': { src: 'fr', tgt: 'en' },
  'es-en': { src: 'es', tgt: 'en' },
  'pt-en': { src: 'pt', tgt: 'en' },
  'nl-en': { src: 'nl', tgt: 'en' },
  'en-fr': { src: 'en', tgt: 'fr' },
  'en-es': { src: 'en', tgt: 'es' },
  'en-pt': { src: 'en', tgt: 'pt' },
  'en-nl': { src: 'en', tgt: 'nl' },
  'de-it': { src: 'de', tgt: 'it' },
  'it-de': { src: 'it', tgt: 'de' },
};

/* 源/目标语言 → 可用的词典库 pair 代码；无则返回 null */
export function dictPairFor(src, tgt) {
  if (DICT_PAIRS[src + '-' + tgt]) return src + '-' + tgt;
  return null;
}

/* 是否可作为词典快路径的查询（单词/短短语）；长句一律走模型 */
export function isSingleToken(text) {
  const t = (text || '').trim();
  if (!t || t.includes('\n')) return false;
  if (/[A-Za-z]/.test(t)) {                       // 拉丁字母：必须是单个空白分隔词
    return t.split(/\s+/).filter(Boolean).length === 1 && t.length <= 40;
  }
  return !/\s/.test(t) && t.length <= 12;         // CJK：无空白、长度适中
}
export function pickChannel(text, mode, termsCount) {
  if (mode === 'fast')    return { key: 'fast',    why: '手动指定快速通道' };
  if (mode === 'quality') return { key: 'quality', why: '手动指定高质量通道' };
  if (termsCount) return { key: 'quality', why: '启用术语干预（' + termsCount + ' 条），需要更强的指令跟随' };
  if (text.length > LONG_THRESHOLD)
    return { key: 'quality', why: '文本 ' + text.length + ' 字（>' + LONG_THRESHOLD + '），质量优先' };
  return { key: 'fast', why: '文本 ' + text.length + ' 字，速度优先' };
}
