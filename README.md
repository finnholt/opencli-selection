# opencli-buyin

OpenCLI 插件 —— 抖音百应(选品广场)商家侧数据采集。

借助你本机 Chrome 已登录的百应账号,通过 OpenCLI 的 INTERCEPT/COOKIE 策略,把选品库的商品/类目/详情数据抓成结构化输出(JSON / CSV / Markdown / 表格)。登录态过期时还能用 `login` 命令抓扫码二维码重新登录。

## 命令一览

| 命令 | 数据 | 策略 | 输出形态 |
|---|---|---|---|
| `opencli buyin products` | 选品库"为你推荐"商品列表(可滚动分页,可类目筛选,默认带完整详情) | INTERCEPT(批量两阶段) | 多行,每行 1 个商品 |
| `opencli buyin categories` | 选品库类目树(顶级 17 项 + 每个顶级下的子级) | COOKIE | 树形 / 拍平 |
| `opencli buyin login` | 抓扫码登录二维码存 PNG / base64,可轮询等扫码完成 | UI(CDP 裁剪截图) | 单行(状态 + 二维码) |

所有命令都默认 `-f table`,加 `-f json/csv/markdown/yaml` 切换输出格式。

## 安装

### 前置

1. 装 OpenCLI(`>=1.8.0`):
   ```bash
   npm install -g @jackwener/opencli
   ```
2. 装 Browser Bridge Chrome 扩展(参考 OpenCLI README)
3. **在你常用的 Chrome 里登录 `https://buyin.jinritemai.com/`**
4. 检查:
   ```bash
   opencli doctor
   ```

### 安装本插件

```bash
# 本地开发(symlink,改代码立即生效)
cd /path/to/opencli-buyin
opencli plugin install file://$(pwd)

# 从 GitHub
opencli plugin install github:<user>/opencli-buyin
```

验证:
```bash
opencli plugin list
opencli buyin --help
```

## 使用示例

### 商品列表

```bash
# 默认 30 条,表格输出
opencli buyin products

# 90 条(自动滚 2 次)
opencli buyin products --limit 90

# 导出 Excel
opencli buyin products --limit 90 -f csv -o ~/buyin-products.csv

# 给脚本管道用
opencli buyin products --limit 30 -f json | jq '.[] | select(.commission_rate >= 20)'

# 按类目过滤(id 从 categories 命令拿)
opencli buyin products --category 5                       # 顶级"美妆"(BusinessCid)
opencli buyin products --category 1000003462              # 子级长 id(MendelCid)
opencli buyin products --category 5,1000003462            # 多个一起传(短/长自动分发)
```

`--category` 接受 id(逗号分隔多个):短 id(<7 位,如 `"5"`)走顶级 `BusinessCid`,长 id(≥7 位,如 `"1000003462"`)走子级 `MendelCid`,**自动识别**。先跑 `opencli buyin categories -f json` 拿 id。

#### 输出列(7 个)

| 列 | 含义 | 单位 |
|---|---|---|
| `name` | 商品名 | — |
| `price` | 售价 | 元 |
| `commission_rate` | 佣金率 | %(20 = 20%) |
| `month_sale` | 月销量 | 件 |
| `product_id` | 商品 ID | — |
| `main_img` | 封面图 URL | — |
| `category` | 原始嵌套类目对象 `{first_category, second_category, third_category, ...}` | JSON |

`category` 在 table 视图显示为 `[object Object]`,要看完整嵌套用 `-f json`。

### 类目树

```bash
# 默认:顶级 17 项,每个带 childs 嵌套
opencli buyin categories -f json

# 单级查询(只看 13 = 食品饮料 下的子级)
opencli buyin categories --parent 13

# 拍平成 CSV
opencli buyin categories --flat -f csv -o ~/buyin-cate-tree.csv
```

#### 类目体系说明

百应选品广场的类目是**精选两层结构**,跟抖音电商完整 4 级商品类目不同:

```
顶级 cate_type=1 (17 项,短 ID 如 "13" "10" "5")
  └── 选品分组 cate_type=3 (每个顶级下少数几个,长 ID 如 "1000000724")
```

- 顶级 ID 用于 `material_list` 接口的类目筛选
- 选品分组的长 ID 跟 `material_list.summary_promotions[].base_model.product_info.category` 字段对应

### 扫码登录二维码

登录态过期(扫码失效后所有命令都会失败)时,用 `login` 重新拿一张二维码扫码登录。二维码是 `open.douyin.com` 的跨域 iframe,读不到 DOM,所以走 **CDP 原生裁剪截图**:每次现量二维码位置(换屏不裁偏),让 Chrome 只截那一块。

```bash
# 抓二维码存 PNG
opencli buyin login --out /tmp/buyin-qr.png

# 抓完后轮询等扫码完成(离开登录页 = 登录态已写入该 Chrome profile)
opencli buyin login --out /tmp/buyin-qr.png --poll --timeout 180

# 只要 base64(不落盘),给服务/前端消费
opencli buyin login --out "" --base64 -f json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--out <path>` | `/tmp/buyin-qr.png` | 二维码 PNG 保存路径;留空 `""` 则不落盘 |
| `--base64` | 关 | 输出 `qr_base64`(`data:image/png;base64,…` URI,前端可直接塞 `<img src>`) |
| `--poll` | 关 | 抓完后轮询 URL,扫码成功(离开 `/mpa/account/login`)即返回 |
| `--timeout <秒>` | `180` | `--poll` 的等待上限 |
| `--scale <n>` | `0` | 截图缩放;`0` = 用页面 devicePixelRatio(Retina 自动 2x) |

#### 输出列(5 个)

| 列 | 含义 |
|---|---|
| `status` | `qr_ready`(已出码) / `logged_in`(`--poll` 扫码成功) / `timeout` / `no_qr`(profile 其实已登录) / `blank_qr`(截到了但二维码始终没画出来) / `shot_failed` |
| `qr_path` | PNG 落盘路径(`--out ""` 时为空) |
| `qr_base64` | `--base64` 时为 data URI,否则空 |
| `logged_in` | 是否扫码登录成功(仅 `--poll` 有意义) |
| `url` | 当前页面 URL |

> ⚠️ 截出的是**那一刻的静态二维码**,抖音二维码有几分钟有效期、扫码状态由 iframe 内部轮询刷新 —— 过期得重抓。做成接口时:返回图给前端 + 同时 `--poll` 判断登录,超时就重抓一张。
>
> 给 Node 服务消费(buyin-service「重新登录」闭环):
> ```js
> import { execFileSync } from 'node:child_process';
> const out = execFileSync('opencli',
>   ['buyin', 'login', '--out', '', '--base64', '-f', 'json'],
>   { env: { ...process.env, OPENCLI_PROFILE: '<profile>' }, encoding: 'utf8' });
> const dataUri = JSON.parse(out)[0].qr_base64; // <img src> 直接可用
> ```

## 字段约定

- **金额单位**:API 返回的 `price.origin` 和 `cos_fee.origin` 都是**分**,adapter 已转换成**元**
- **百分数**:API 返回的 `cos_ratio.origin = 10` 表示 **10%**,不是 0.10。Adapter 透传原值
- **时间戳**:API 内部用 `YYYYMMDDHHMMSSXXXX` 字符串(如 `log_pb` 字段)

## 已知限制

| 限制 | 原因 |
|---|---|
| 必须本机 Chrome 登录,无法服务器 headless 直跑 | 百应 a_bogus 签名靠浏览器自家 JS hook |
| 商品列表暂不支持 `search_text` / 销量区间等其他筛选 | 仅在 body 改写器里塞了 `filters.{BusinessCid,MendelCid}`,其余维度按需再加 |
| `--limit 300+` 会很慢,且可能触发风控 | 每 30 条要滚 1 次,~3 秒/页 |
| `product` 详情每次都要先发列表拿 token | 接口强制要求 search_id/session_id,5~30 分钟内有效 |
| 老 promotion_id 可能返回空字段 | 商家已下架/换推广周期 |
| 类目筛选只到二层(顶级 + 选品分组) | 百应选品广场设计如此,商品自身有 3~4 级类目 |

## 反爬与合规

- 自用 / 低频(每小时几次)几乎无风险
- 高频(每分钟级别)会触发风控:滑块、IP 限速、账号封禁
- 抓回来的数据**不要二次分发**或做成对外产品,百应 ToS 明面禁止
- `high_light` 字段直接暴露商家私人微信/手机,使用时注意合规

## 开发

```bash
# 本地修改后,symlink 安装下命令立即生效
vim products.js
opencli buyin products --limit 5

# 改了 opencli-plugin.json 或加了 .ts 文件,要重装
opencli plugin update opencli-buyin

# 卸载
opencli plugin uninstall opencli-buyin
```

### 项目结构

```
opencli-buyin/
├── _shared/
│   └── browser-fetch.js     # 同源 fetch 工具(借浏览器签名)
├── products.js              # 商品列表 + 批量详情(INTERCEPT)
├── categories.js            # 类目树(COOKIE)
├── login.js                 # 扫码登录二维码(UI / CDP 裁剪截图)
├── opencli-plugin.json      # 插件元信息
└── package.json
```

### 关键设计

1. **INTERCEPT vs COOKIE 的选择**
   - `material_list` / `pack_detail`:POST body 由页面 JS 构造(含签名),走 INTERCEPT 让页面自己发
   - `cate_info`:GET,参数简单,走 COOKIE 在同源页面直接 fetch
2. **SPA 路由保留 fetch patch**
   - `installInterceptor` 装的 patch 只在当前 window 上;`page.goto()` 整页刷新会抹掉 patch
   - 因此用 `history.pushState + popstate` 在不刷新前提下切路由
3. **session token 两阶段**
   - `material_list` 响应里的 `data.extra.search_id` / `session_id` / `data.log_id` 是详情接口的鉴权前提
   - 批量循环里每 ~25 条主动 SPA 回列表刷一次 token,规避 5~30 分钟的 session 过期
4. **登录二维码靠 CDP 裁剪截图**(`login.js`)
   - 二维码在 `open.douyin.com` 跨域 iframe 里,扩展 content script 注入不进去、读不到 DOM
   - 改用 `page.cdp('Page.captureScreenshot', { clip })` 让 Chrome 原生只截二维码那一块;坐标每次现量,换屏不裁偏

## License

Apache-2.0
