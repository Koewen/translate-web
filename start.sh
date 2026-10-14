#!/bin/bash
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"
cd /mnt/d/Docker/stacks/translate-web || exit 1

echo "===== 1) 启动 translate-web ====="
docker compose up -d 2>&1 | tail -5
sleep 4
docker ps -a --filter name=translate-web --format '{{.Names}}|{{.Status}}|{{.Ports}}'

echo
echo "===== 2) 页面是否可访问 ====="
docker exec translate-web wget -qO- http://127.0.0.1/ 2>&1 | head -c 200
echo
echo

echo "===== 3) 🔴 反代到 Ollama 是否通（关键）====="
echo "--- GET /ollama/api/tags ---"
docker exec translate-web wget -qO- http://127.0.0.1/ollama/api/tags 2>&1 | head -c 400
echo
echo
echo "--- POST /ollama/api/chat（真实翻译）---"
docker exec translate-web wget -qO- \
  --header='Content-Type: application/json' \
  --post-data='{"model":"MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M","messages":[{"role":"user","content":"将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nThe server is now healthy."}],"stream":false,"options":{"temperature":0.7,"top_k":20,"top_p":0.6,"repeat_penalty":1.05}}' \
  http://127.0.0.1/ollama/api/chat 2>&1 | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('  译文:', (d.get('message') or {}).get('content','(无)').strip())
    print('  耗时: %.2fs' % (d.get('total_duration',0)/1e9))
except Exception as e:
    print('  解析失败:', e, sys.stdin.read()[:200] if False else '')
"

echo
echo "===== 4) LibreTranslate 状态 ====="
docker ps -a --filter name=libretranslate --format '{{.Names}}|{{.Status}}|{{.Ports}}'
docker logs libretranslate --tail 12 2>&1
