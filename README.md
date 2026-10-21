# 本地翻译工作台

自托管的翻译工作台。所有文本只在本地或内网处理，不上传任何第三方云服务。翻译走本机 Ollama 上的模型；前端基于 Vue 3 与 Element Plus，后端仅用 Python 标准库加 SQLite，没有第三方运行时依赖。

## 功能特性

- 原文与译文左右并排，中间悬浮一个交换按钮，一键互换语言与内容。
- 术语干预：维护一张「原文术语 → 指定译名」词典，翻译时按指定译法强制输出。
- 翻译历史：所有译文落库到本地 SQLite，支持按原文或译文检索、回填原文、清空。
- 语种自动识别：基于字符分布与停用词的本地启发式算法，覆盖 36 种语言，不依赖外部接口。
- 模型通道：按文本长度（默认 1500 字）与术语数量自动选择标准通道或长文通道。
- 离线词典快路径：内置多语种开源词典（中/日/法/西/葡/荷/德/意），单词与短词先查本地词典，命中即秒回，不调用模型。
- 玻璃拟态界面，带流动极光背景；支持浅色与深色切换。
- 单屏布局，页面级无滚动条；窗口宽度低于 1080px 时右栏自动收为抽屉。
- 顶栏显示 Ollama 驻留模型与显存占用，可手动卸载模型释放显存。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端框架 | Vue 3.5.44（全局构建，挂载到 `window.Vue`，无需打包） |
| UI 组件 | Element Plus 2.14.7 + Element Plus Icons + 中文 locale |
| 后端 | Python 3.12（仅标准库：`http.server`、`sqlite3`） |
| 数据库 | SQLite（WAL 模式） |
| 翻译引擎 | 本机 Ollama + Qwen3.5 9B |
| 部署 | Docker Compose（nginx:alpine + python:3.12-alpine） |

## 目录结构

```
translate-web/
├── compose.yaml          # 两个服务：translate-web(nginx)、translate-api(python)
├── default.conf          # nginx 配置：静态资源 + /api/ + /ollama/ 反代
├── start.sh              # 一键诊断 / 启动脚本
├── api/
│   ├── main.py           # 标准库 HTTP API（ThreadingHTTPServer）
│   ├── db.py             # SQLite 数据层（terms / history / dict）
│   └── dict_import.py    # 离线词典导入（CC-CEDICT / FreeDict + 反向词典）
├── html/
│   ├── index.html        # 入口，含 .aurora 流光背景层
│   ├── favicon.svg
│   ├── css/theme.css      # 玻璃主题、流光动画、深浅色变量
│   ├── js/
│   │   ├── app.js         # 应用入口：布局 / 主题 / 旧数据迁移
│   │   ├── store.js       # 全局响应式状态
│   │   ├── api.js         # 前端 API 封装（terms / history / ollama）
│   │   ├── translator.js  # 语言表 / 语种识别 / 通道路由 / 提示词
│   │   └── components/    # TranslatePane / TermsPanel / HistoryPanel
│   └── vendor/           # 第三方库（vue / element-plus 等，已离线内置）
└── data/                 # 运行时 SQLite（translate.db + dict.db），不纳入版本控制
```

## 快速开始

前置条件：已安装 Docker，且本机（或网络可达的机器）运行 Ollama。其地址通过 `host.docker.internal:11434` 访问宿主机上的 Ollama——该名称由 compose 的 `extra_hosts` 映射到 `.env` 里的 `OLLAMA_HOST_IP`（不写死内网地址，`.env` 已 gitignore）。首次部署请创建 `.env` 并填入你的 Ollama 主机可达地址；若使用其他网络拓扑，请相应修改 `OLLAMA_HOST_IP`。

```bash
git clone https://github.com/Koewen/translate-web.git
cd translate-web
docker compose up -d
```

静态页面由 translate-web 容器提供，API 由 translate-api 容器提供，两个容器在同一 compose 网络中通过服务名互访。数据库文件落在宿主机的 `./data/translate.db`。

## 配置

- 翻译引擎地址：编辑 `default.conf` 的 `/ollama/` 段，把 `proxy_pass` 改成你的 Ollama 主机地址。
- 服务端口与数据库路径：translate-api 通过环境变量 `TRANSLATE_BIND`、`TRANSLATE_PORT`、`TRANSLATE_DB` 控制，默认 `0.0.0.0:8000` 与 `/data/translate.db`。
- 长文阈值：前端 `translator.js` 中的 `LONG_THRESHOLD`（默认 1500 字符），超过即走长文通道。
- 请求体上限：API 限制 1MB，nginx 的 `/api/` 段限制 2MB。

## API 说明

所有接口同源（由 nginx 反代，无需处理 CORS）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/stats` | 计数（启用术语数 / 历史条数 / 词典词条数） |
| GET | `/api/terms?enabled=1` | 术语列表（`enabled=1` 仅返回启用项） |
| POST | `/api/terms` | 新增或更新术语（按 `src` 幂等） |
| PUT | `/api/terms/{id}` | 修改术语 |
| DELETE | `/api/terms/{id}` | 删除术语 |
| GET | `/api/history?limit&offset&q` | 历史列表（倒序，`q` 检索原文或译文） |
| POST | `/api/history` | 写入一条历史 |
| DELETE | `/api/history/{id}` | 删除单条 |
| DELETE | `/api/history` | 清空历史 |
| GET | `/api/dict?q=&pair=` | 离线词典查询（`q` 词头，`pair` 语对） |

## 数据库结构

使用 SQLite：用户数据（术语 / 历史）在 `./data/translate.db`，离线词典在 `./data/dict.db`。

```sql
-- 术语干预词典：src(原文术语,唯一) -> dst(指定译名)
CREATE TABLE terms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    src        TEXT NOT NULL UNIQUE,
    dst        TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 翻译历史：源文 / 译文 / 语对 / 模型 / 字数 / 耗时
CREATE TABLE history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    src_text    TEXT NOT NULL,
    dst_text    TEXT NOT NULL,
    src_lang    TEXT NOT NULL DEFAULT '',
    dst_lang    TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    chars       INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

-- 离线词典（静态）：pair(语对) + src(词头) + dst(释义) + pos(词性) + reading(读音)
-- 独立存放于 ./data/dict.db，避免大批量写入锁住主库
CREATE TABLE dict (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pair       TEXT NOT NULL,
    src        TEXT NOT NULL,
    dst        TEXT NOT NULL,
    pos        TEXT NOT NULL DEFAULT '',
    reading    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_dict_pair_src ON dict(pair, src);
```

## 离线词典（可选）

除模型翻译外，另有一条离线词典快路径：当输入是单个单词或短词、且当前语向有对应词典时，先查本地 SQLite 词典，命中即展示词典结果，不调用模型；未命中再回退模型。多条解释会分区呈现：顶部是词头（带拼音/词性标签），下面每条解释一张卡片，含**概要**（去括注的核心说法，首条加粗强调）与**细节**（括注/限定，缩进标注），互不干扰；窄屏下自动减小缩进与字号。查询接口为 `GET /api/dict?q=&pair=`，前端会在「路由说明」行标注「命中离线词典」，并把译文来源记为词典。

内置词典来自两个开源项目（均 CC-BY-SA / GPL）：

| 来源 | 方向 | 说明 |
| --- | --- | --- |
| CC-CEDICT | 中 ⇄ 英 | 汉英词典，纯文本，含拼音 |
| FreeDict | 日/法/西/葡/荷/德/意 ⇄ 英 | TEI XML，多语对 |

当前覆盖的语对（`pair`）：`zh-en`、`en-zh`、`ja-en`、`en-ja`、`fr-en`、`en-fr`、`es-en`、`en-es`、`pt-en`、`en-pt`、`nl-en`、`en-nl`、`de-it`、`it-de`。其中 `en-zh`、`en-ja` 为反向词典，由脚本从 `zh-en`、`ja-en` 派生，并补录了一批高频招呼语，保证默认「外文词 → 中文」方向的常见词也能秒回。

词典为独立数据库 `./data/dict.db`，体量较大（百万级词条），未纳入版本控制。导入需先自行下载开源词库（CC-CEDICT 文本与 FreeDict 目录，来源与用法见 `api/dict_import.py` 顶部注释），再在 `api/` 目录执行：

```bash
TRANSLATE_DICT_DB=./data/dict.db python dict_import.py --cedict /path/cedict.txt --freedict /path/fd-dictionaries
TRANSLATE_DICT_DB=./data/dict.db python dict_import.py --reverse
```

不导入词典时，快路径自动跳过，全部走模型，其余功能不受影响。
