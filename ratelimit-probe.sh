#!/usr/bin/env bash
#
# 百应限流探针:定时跑一小批 products 详情,把「成功/被风控/报错」结构化记进 CSV,
# 跑几天后看 CSV 就能经验性地摸出限流阈值(什么频率/累计量开始掉详情、弹「网络不稳定」)。
#
# 判定逻辑:products 只返回 detail_ok=true 的条目,所以
#   got < requested  →  有详情被限流/失败
#   got == 0         →  整批被拦(多半风控)
# 再扫 stdout+stderr 的文案(网络不稳定/滑块/登录失效)给一个分类标签。
#
# ⚠️ 必须跑在「已登录 GUI 会话」里(Chrome + Browser Bridge 扩展 + daemon 都要在)。
#    所以定时用 **用户 LaunchAgent**(在 Aqua 图形会话里跑),不要用 root cron —— 见文件末尾。

set -uo pipefail

# ── 可调参数(也可用环境变量覆盖)──
PROFILE="${OPENCLI_PROFILE:-7jgudy3t}"
LIMIT="${PROBE_LIMIT:-3}"                       # 每次抓几条详情
CMD_TIMEOUT="${PROBE_TIMEOUT:-300}"             # 单次最长跑多久(秒),防卡死
OPENCLI_BIN="${OPENCLI_BIN:-$(command -v opencli || echo /usr/local/bin/opencli)}"
LOG_DIR="${PROBE_LOG_DIR:-$HOME/selection-ratelimit-probe}"

CSV="$LOG_DIR/probe.csv"
mkdir -p "$LOG_DIR/raw"

ts="$(date '+%Y-%m-%d %H:%M:%S')"
stamp="$(date '+%Y%m%d-%H%M%S')"
raw_out="$LOG_DIR/raw/$stamp.stdout.json"
raw_err="$LOG_DIR/raw/$stamp.stderr.log"

# CSV 表头(只在首次创建时写)
if [[ ! -f "$CSV" ]]; then
  echo "ts,requested,got,duration_s,exit_code,verdict,note" > "$CSV"
fi

# ── 跑一次 ──
start=$(date +%s)
OPENCLI_PROFILE="$PROFILE" "$OPENCLI_BIN" selection products \
  --limit "$LIMIT" -f json \
  > "$raw_out" 2> "$raw_err"
exit_code=$?
end=$(date +%s)
duration=$((end - start))

# ── 解析结果 ──
# got = 返回 JSON 数组里 detail_ok=true 的条数(products 已只返回成功条,这里数数组长度)
if command -v jq >/dev/null 2>&1 && jq -e . "$raw_out" >/dev/null 2>&1; then
  got=$(jq 'if type=="array" then length else 0 end' "$raw_out")
else
  # jq 不可用或不是合法 JSON(多半整批失败):退化成数 detail_ok":true 出现次数
  got=$(grep -o '"detail_ok":true' "$raw_out" 2>/dev/null | wc -l | tr -d ' ')
fi

# 扫文案给分类标签(stdout+stderr 一起扫)
blob="$(cat "$raw_out" "$raw_err" 2>/dev/null)"
verdict=""
note=""
if echo "$blob" | grep -qE '网络不稳定|网络异常|网络开小差'; then
  verdict="net_unstable(疑风控)"
elif echo "$blob" | grep -qE '滑块|验证码|captcha|verify|安全验证'; then
  verdict="captcha(风控)"
elif echo "$blob" | grep -qiE '登录失效|未登录|not.?login|AuthRequired|请重新登录'; then
  verdict="auth(登录态丢失)"
elif [[ "$exit_code" -ne 0 ]]; then
  verdict="error(exit=$exit_code)"
elif [[ "$got" -eq 0 ]]; then
  verdict="empty(整批掉)"
elif [[ "$got" -lt "$LIMIT" ]]; then
  verdict="partial($got/$LIMIT)"
else
  verdict="ok"
fi
# 抓一条 stderr 末行当 note(去掉逗号/换行,免得撑破 CSV)
note="$(tail -n 1 "$raw_err" 2>/dev/null | tr ',\n' ';;' | cut -c1-120)"

# ── 落 CSV + 控制台回显 ──
echo "$ts,$LIMIT,$got,$duration,$exit_code,$verdict,$note" >> "$CSV"
echo "[$ts] requested=$LIMIT got=$got ${duration}s exit=$exit_code -> $verdict"
