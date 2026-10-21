# 参与贡献

欢迎提交 Issue 与 Pull Request。本项目是一个自托管的本地翻译工作台，所有文本只在本地/内网处理。

## 本地运行

```bash
git clone https://github.com/Koewen/translate-web.git
cd translate-web
# 创建 .env 并填入你的 Ollama 主机可达地址（OLLAMA_HOST_IP）
docker compose up -d
```

## 贡献流程

1. Fork 本仓库并创建特性分支：`git checkout -b feat/your-change`
2. 提交改动并推送：`git commit -m "feat: ..." && git push origin feat/your-change`
3. 在 GitHub 上发起 Pull Request，描述改动目的

## 约定

- 后端仅使用 Python 标准库，请勿引入第三方运行时依赖。
- 前端为免打包的全局构建（Vue/Element Plus 已离线内置），改动后直接更新 `html/` 即可。
- **不要提交** `.env`（含内网 IP 等敏感信息）与 `data/`（运行时 SQLite）。
- 离线词典（`dict.db`）体量较大且来自第三方开源词库，不纳入版本控制；导入方式见 README。

## 反馈

遇到 bug 或希望新功能，请先检索已有 Issue，再开新 Issue 并尽量附上复现步骤与环境信息。
