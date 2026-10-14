# -*- coding: utf-8 -*-
"""
离线词典导入脚本（仅标准库）。

数据源（全部开源、CC-BY-SA / GPL）：
  - CC-CEDICT : 中⇄英，纯文本，格式 `繁 简 [pinyin] /gloss/gloss/`
  - FreeDict  : 多语种 .tei（TEI XML），目录 <pair>/<pair>.tei，如 jpn-eng/jpn-eng.tei

反向词典（--reverse）：从已导入的 zh-en / ja-en 中抽取「英文单词头 → 中文/日文」，
  自动补全 en-zh / en-ja 两个方向，覆盖默认的「外文单词 → 中文」查词场景。

用法（在 api/ 目录下运行，需能 import db）：
  python dict_import.py --cedict /path/cedict.txt --freedict /path/fd-dictionaries
  python dict_import.py --only cedict /path/cedict.txt
  python dict_import.py --only freedict /path/fd-dictionaries
  python dict_import.py --reverse            # 仅构建反向词典（en-zh / en-ja）

导入目标库由环境变量 TRANSLATE_DICT_DB 控制（默认 /data/dict.db）。
词典库与用户可变数据(terms/history)分库，避免大批量写入锁住主库。
"""
import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402

TEI_NS = "{http://www.tei-c.org/ns/1.0}"

# FreeDict 目录名 -> 词典库 pair 代码（与前端 translator.js 的 DICT_PAIRS 对应）
FREEDICT_MAP = {
    "jpn-eng": "ja-en",
    "fra-eng": "fr-en",
    "spa-eng": "es-en",
    "por-eng": "pt-en",
    "nld-eng": "nl-en",
    "eng-fra": "en-fr",
    "eng-spa": "en-es",
    "eng-por": "en-pt",
    "eng-nld": "en-nl",
    "deu-ita": "de-it",
    "ita-deu": "it-de",
}

CEDICT_RE = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+(/.*/)\s*$")


def _strip_tone(pinyin: str) -> str:
    return re.sub(r"\d", "", pinyin).strip()


def import_cedict(path: str) -> int:
    """解析 CC-CEDICT 纯文本，写入 pair='zh-en'。返回条数。"""
    if not os.path.isfile(path):
        print("  [skip] CC-CEDICT 文件不存在: %s" % path)
        return 0
    rows = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            m = CEDICT_RE.match(line)
            if not m:
                continue
            trad, simp, pinyin, gloss = m.group(1), m.group(2), m.group(3), m.group(4)
            # 释义：去掉首尾斜杠后按 / 切分
            g = gloss.strip("/")
            dst = " / ".join(x.strip() for x in g.split("/") if x.strip())
            if not dst:
                continue
            # 优先用简体作词头；若简体含非汉字（如纯数字 110）则回退繁体
            src = simp if re.search(r"[一-鿿]", simp) else trad
            rows.append((src, dst, "", _strip_tone(pinyin)))
    db.clear_dict("zh-en")
    total = db.import_dict_entries("zh-en", rows)
    print("  [ok] CC-CEDICT(zh-en): %d 条" % total)
    return total


def _local(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def import_freedict_pair(dir_path: str, pair_code: str) -> int:
    tei = None
    for f in os.listdir(dir_path):
        if f.endswith(".tei"):
            tei = os.path.join(dir_path, f)
            break
    if not tei:
        return 0
    rows = []
    try:
        ctx = ET.iterparse(tei, events=("end",))
        for event, elem in ctx:
            if _local(elem.tag) != "entry":
                continue
            # 词头（orth）
            heads = []
            for form in elem.iter(TEI_NS + "form"):
                for orth in form.iter(TEI_NS + "orth"):
                    if orth.text:
                        heads.append(orth.text.strip())
            # 译文（sense -> cit[type=trans] -> quote）
            quotes = []
            pos = ""
            for sense in elem.iter(TEI_NS + "sense"):
                for p in sense.iter(TEI_NS + "pos"):
                    if p.text and not pos:
                        pos = p.text.strip()
                for cit in sense.iter(TEI_NS + "cit"):
                    if _local(cit.get("type", "")) == "trans":
                        for q in cit.iter(TEI_NS + "quote"):
                            if q.text:
                                quotes.append(q.text.strip())
            if not heads or not quotes:
                elem.clear()
                continue
            dst = " / ".join(quotes)
            for h in heads:
                if h:
                    rows.append((h, dst, pos, ""))
            elem.clear()
    except ET.ParseError as e:
        print("  [warn] 解析失败 %s: %s" % (tei, e))
        return 0
    db.clear_dict(pair_code)
    total = db.import_dict_entries(pair_code, rows)
    print("  [ok] FreeDict(%s): %d 条" % (pair_code, total))
    return total


def import_freedict(root: str) -> int:
    if not os.path.isdir(root):
        print("  [skip] FreeDict 目录不存在: %s" % root)
        return 0
    total = 0
    for dname, pair in FREEDICT_MAP.items():
        dp = os.path.join(root, dname)
        if not os.path.isdir(dp):
            continue
        total += import_freedict_pair(dp, pair)
    return total


# 反向词典：从 zh-en / ja-en 派生 en-zh / en-ja。
# 只取每条词目的「首个英文释义片段」且为干净单词头（去停用词），多义词仅展示首要义项，
# 噪声小、规模可控，足够离线快路径使用。
EN_STOP = set("""
a an the and or but if because so of to in on for with as at by from your you we they
he she it his her its their our this that these those is are was were be been being have
has had do does did will would shall should can could may might must not no yes i me my
mine who what which when where why how more most some such only also than then there here
about into over under above below out up down off between among through during before after
""".split())


def build_reverse():
    """从已导入的 zh-en / ja-en 派生 en-zh / en-ja 反向词典（首片段单词头）。"""
    import sqlite3
    path = db.DICT_DB_PATH
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    total = 0
    try:
        for src_pair, tgt_pair in (("zh-en", "en-zh"), ("ja-en", "en-ja")):
            rows = con.execute(
                "SELECT src, dst FROM dict WHERE pair=?", (src_pair,)
            ).fetchall()
            out, seen = [], set()
            for r in rows:
                # 仅取「首个释义片段」的第一个干净英文单词头，作为首要对应词。
                # 这样噪声最小（多义词只展示首要义项）；招呼语/高频词由 build_curated 补录。
                tok = None
                for seg in re.split(r"\s*/\s*", r["dst"] or "")[:1]:
                    for t in re.findall(r"[a-z][a-z'\-]*", seg.lower()):
                        if len(t) < 2 or len(t) > 12:
                            continue
                        if t in EN_STOP:
                            continue
                        tok = t
                        break
                if not tok:
                    continue
                key = tok + "\x00" + r["src"]
                if key in seen:
                    continue
                seen.add(key)
                out.append((tok, r["src"], "", ""))
            if out:
                db.clear_dict(tgt_pair)
                db.import_dict_entries(tgt_pair, out)
                print("  [ok] 反向词典(%s): %d 条" % (tgt_pair, len(out)))
                total += len(out)
    finally:
        con.close()
    print("反向词典完成，共 %d 条。" % total)


# 高频招呼语/虚词补录（en-zh / en-ja）：CC-CEDICT 的英文侧多为短语释义，
# 其「首个片段」常取不到 hello/thanks 这类词，故显式补录，保证默认方向常见词也能秒回。
CURATED_EN_ZH = {
    "hello": "你好", "hi": "嗨；你好", "hey": "嘿；你好", "thanks": "谢谢",
    "please": "请", "yes": "是；对", "no": "不；否", "goodbye": "再见",
    "bye": "再见", "good": "好", "sorry": "抱歉；对不起", "welcome": "欢迎",
    "love": "爱", "ok": "好；可以",
}
CURATED_EN_JA = {
    "hello": "こんにちは", "hi": "やあ；こんにちは", "thanks": "ありがとう",
    "please": "お願いします", "yes": "はい", "no": "いいえ", "goodbye": "さようなら",
    "bye": "ばいばい", "good": "良い", "sorry": "ごめんなさい", "welcome": "ようこそ",
    "love": "愛", "ok": "大丈夫",
}


def build_curated():
    """高频招呼语/虚词补录（en-zh / en-ja），追加在反向词典之后（不清除）。"""
    total = 0
    for pair, mp in (("en-zh", CURATED_EN_ZH), ("en-ja", CURATED_EN_JA)):
        rows = [(k, v, "", "") for k, v in mp.items()]
        db.import_dict_entries(pair, rows)
        print("  [ok] 补录(%s): %d 条" % (pair, len(rows)))
        total += len(rows)
    print("高频词补录完成，共 %d 条。" % total)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cedict", help="CC-CEDICT 文本路径")
    ap.add_argument("--freedict", help="FreeDict fd-dictionaries 目录")
    ap.add_argument("--only", choices=["cedict", "freedict"], help="只导入某一类")
    ap.add_argument("--reverse", action="store_true", help="仅构建反向词典 en-zh / en-ja（含高频词补录）")
    args = ap.parse_args()

    db.DICT_DB_PATH = os.environ.get("TRANSLATE_DICT_DB", db.DICT_DB_PATH)
    print("目标词典库:", db.DICT_DB_PATH)
    grand = 0
    if args.reverse:
        build_reverse()
        build_curated()
        return
    if args.only in (None, "cedict") and args.cedict:
        grand += import_cedict(args.cedict)
    if args.only in (None, "freedict") and args.freedict:
        grand += import_freedict(args.freedict)
    print("完成，共导入 %d 条。" % grand)


if __name__ == "__main__":
    main()
