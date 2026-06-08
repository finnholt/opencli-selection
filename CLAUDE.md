# CLAUDE.md

给 AI/Claude 在这个仓库工作时的上下文文档。新手 / 新会话从这里开始。

## 项目本质

**OpenCLI 插件**,把抖音百应(buyin.jinritemai.com)选品广场的商家侧数据封装成 CLI 命令。

- **不是**独立爬虫,而是 OpenCLI 注册的命令包,装到 `~/.opencli/plugins/opencli-buyin/`
- **不能**在无浏览器的服务器裸跑 —— 依赖本机已登录的 Chrome + Browser Bridge 扩展 + OpenCLI daemon
- **每条命令**用 `cli({...})` API 注册,文件名 = 命令名(去掉 `.js`),`site` 字段决定命令前缀

## 当前命令面(3 条)

| 文件 | 命令 | 策略 | 干啥 |
|---|---|---|---|
| `products.js` | `opencli buyin products` | INTERCEPT(批量两阶段) | 选品库商品列表**默认带完整详情**(逐条 pack_detail,慢) |
| `categories.js` | `opencli buyin categories` | COOKIE | 拉选品库类目树(3 层) |

## 关键架构决策

### 1. 为什么 INTERCEPT 不用 COOKIE

`material_list` 和 `pack_detail` 都是 **POST**,且 POST body 由百应自家 React 内部拼(含 channel_id / search_id / 业务签名等)。我们无法可靠手写 body。

→ 用 INTERCEPT 让页面自己发,我们只录响应。

`cate_info` 是 GET,参数简单,所以用 COOKIE 直接 fetch。

### 2. SPA 路由保留 fetch patch(必须懂)

`installInterceptor` 只在**当前 window** 装 patch(monkey-patch `window.fetch` + XHR)。
**整页刷新会清掉 patch**,因此:

```js
// ❌ 错的:goto 后装 patch — 没有人触发请求
await page.installInterceptor('foo');
await page.goto('https://buyin.jinritemai.com/some/page');  // 整页刷新,patch 没了
await page.waitForCapture();

// ✅ 对的:先 goto 同源页 → 装 patch → SPA pushState 切路由(不刷新)
await page.goto('https://buyin.jinritemai.com/dashboard');
await page.wait(3);
await page.installInterceptor('foo');
await page.evaluate(`() => {
  window.history.pushState({}, '', '/some/spa/path');
  window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}`);
await page.waitForCapture(10);
```

跨命令复用这套套路。

### 3. pack_detail 两阶段(products 批量详情核心)

百应详情接口**强制要求 session token**,裸调返回 `-1025 "请求失败"`。

```
阶段 1:material_list
  └→ 取 data.extra.search_id
  └→ 取 data.extra.session_id   (首次跟 search_id 同值,后续可能分叉)
  └→ 取 data.log_id (用作 log_pb)

阶段 2:pack_detail
  └→ URL 带 commodity_id + product_id + search_id + session_id + log_pb + decision_enter_from
  └→ SPA 切到 /merch-promoting?... → React 自动发 POST
  └→ 录响应,等 5s 让"完整版"也回来(有时分两次发:轻量探测 + 完整详情)
  └→ find 时必须用 `c?.data?.model?.product?.product_base`,跳过只有 risk_tip 的轻量响应
```

### 3.5 `products.js` 批量带详情(新)

2026-06-01 起 `products` 命令**默认就走批量详情**:

```
阶段 1:scroll material_list 凑齐 desired 条 → 收集 product_id + 取最新 token
阶段 2:逐条 [中转页] → SPA 到 /merch-promoting?... → 抓 pack_detail
        - 每条先 SPA 跳「违规中心」中转页做路由重置(见下),再跳详情
        - 每 25 条 SPA 回选品库刷一次 token(refreshTokens,规避 session 过期)
        - 每条间隔 delay (默认 4s) + 随机 jitter (默认 2s)
        - 每 N=5 条插一个长停顿(默认 8s)
        - 失败条目只保留 list 字段,detail_ok=false,不中断整批
```

**逐条「路由重置」中转页(2026-06-08 优化)**:详情路由 `/merch-promoting?productId=X`
只变 query 不变 pathname,React Router 当成同一路由 → 详情组件不 remount → 不重发 pack_detail。
所以每条详情前必须先跳一个 **不同 pathname** 的路由把详情组件卸载掉。

- 中转页 = `/dashboard/content/author-violation`(`INTERIM_PATH`),**裸路径即可**,
  `universal_page_params_id` 由 React 自动补;走 governance 接口面,**完全不碰 material_list**,
  不给选品广场风控加计数(旧版用"回选品库",每条多发一个带签名的 material_list POST)。
- 确认信号 = 轮询 DOM 等 `h1/h2/h3` 出现「违规中心」(`INTERIM_MOUNT_TEXT`,`waitForInterimMount`),
  抗缓存、比等请求快;**await 它** = 防止连续两次 pushState 被 React 合并、跳过中转那步。
- ⚠️ 只有逐条的路由重置改了;**token 刷新仍走选品库**(material_list 才有 search_id/session_id)。

参数:`--delay <ms>` / `--jitter <ms>` / `--pause_every <n>` / `--pause_ms <ms>` / `--interim_dwell <ms>`(中转页停留,拟人,默认 1500)。

**筛选参数**(都走 `installFilters` 改写 material_list 的 POST body,可叠加):
- `--category <ids>`:类目(短 id→BusinessCid 顶级 / 长 id→MendelCid 子级)
- `--sales <区间>`:月销 `alliance_sales_30d`,如 `R:5000,-`(≥5000)
- `--price <区间>`:售价 `Price`(单位**元**),如 `R:50,100`
- `--commission <区间>`:佣金率 `CosRatio`(**百分比**),如 `R:40,50`

区间值**整段传、不 split**(`R:min,max` 自带逗号;`-` 表示不限),原样包成 `{ value: [<raw>] }`。

**90 条商品大约 10-15 分钟,且**触发风控概率仍不低(滑块/冷却),没有零风险方案。**仅在后端真的需要详情时用**;只需要 list 字段时直接看 `mergeListAndDetail` 里 list 来源那几个字段就够,或者跑一条 `--limit 30` 取首批。

捕获匹配:**按响应自带的 `data.product_id` 在全量 captures 里直接定位**当前商品的响应,不依赖 buffer 游标(切 pattern 时清空时机会跟 processedIdx 错位,曾导致偶数项漏完整版)。匹配后再按内容挑:完整版找 `product_base`,promotion 数据找 `promotion_data.calculate_data`。

### 4. 字段映射约定

百应 API 大量用 `{ origin, integer, decimal, suffix }` 四件套封装数值(给前端格式化)。我们只取 `.origin`。

- **金额**:`price.origin` / `cos_fee.origin` 单位是 **分**,统一 `/100` 转**元**
- **百分数**:`cos_ratio.origin = 10` 直接表示 **10%**,**不要再 ×100**;`good_ratio.origin = 92.93` 也是百分数
- **时间戳**:`log_pb` 是 `YYYYMMDDHHMMSSXXX` 字符串

工具函数都在每个 .js 文件底部:`fenToYuan` / `round1` / `parseRatio` / `joinCategory`。

### 5. `_shared/browser-fetch.js`

把"在同源页面里 evaluate fetch"封装成一个 helper,自动处理:
- credentials: include(带 cookie)
- 错误码识别(401/403/-1025 等)
- 抛 `AuthRequiredError` / `CommandExecutionError`

`categories.js` 等 COOKIE 策略命令用它。`products.js` 走 INTERCEPT,**不用**这个 helper。

## 已知的百应 API 表

每次写新命令前对照查这张表,避免重复 recon。

| 接口 | 方法 | 作用 | 鉴权 |
|---|---|---|---|
| `/pc/selection/common/cate_info` | GET | 类目列表(`cate_type=1` 顶级,`cate_type=3&parent_id=X` 子级) | cookie 即可 |
| `/pc/selection/common/material_list` | POST | 商品列表(选品广场) | cookie + a_bogus |
| `/pc/selection/common/filter_info` | POST | 筛选维度树(销量/价格/佣金等) | cookie |
| `/pc/selection/decision/pack_detail` | POST | 商品详情(决策包) | cookie + a_bogus + search_id/session_id/log_pb |
| `/pc/selection/search/query/recommend` | GET | 搜索框推荐词(已删 recommend.js) | cookie |
| `/pc/selection/common/btm_mapping` | POST | 埋点路径翻译(开发可忽略) | cookie |
| `/pc/selection/common/ab_param` | GET | AB 测试参数(开发可忽略) | cookie |
| `/channel_activity_pc_api/selection_square/channel` | GET | 流量扶持等专题板块商品 | cookie |
| `/pc/selection_square/author/info` | GET | 达人信息 | cookie |

## 调试 recon 流程

加新接口前,**先 recon 弄清接口**。标准步骤:

```bash
# 1. 起 scout 会话(每次 recon 都用同一个 session 名 "scout")
opencli browser scout close 2>/dev/null
opencli browser scout open "https://buyin.jinritemai.com/dashboard/merch-picking-library"

# 2. 在 Chrome 里手动操作(点击、滚动、切 tab)触发要找的接口

# 3. dump 全部
opencli browser scout network > ~/recon-buyin-<feature>.json

# 4. 按 size 排,挑大的 buyin 接口(去掉已知埋点)
jq '[.entries[]
     | select(.url | test("jinritemai"))
     | select(.size > 200)
     | (.url | split("?")[0]) as $u
     | select($u | test("material_list|cate_info|filter_info|btm_mapping|getUser|ab_param|search/query/recommend|login|notice|account|ecomauth|aff/check_login|im/token|qualification|anchor|getResource|hybrid|backstage/token|sd/by/account|tcc|monitor|abtest|mssdk|permission/menu|impression|m_get_cart_sum|ai/boarding") | not)
     | {url: $u, size, method, key}]
    | unique_by(.url)
    | sort_by(-.size)
    | .[]' ~/recon-buyin-<feature>.json

# 5. 看具体响应
opencli browser scout network --detail "<那条 key>" --max-body 15000 | jq '.body'
```

## 常见任务速查

### 改某个命令的输出字段

直接改对应 `.js` 文件的 `columns` 数组和 `mapXxx` 函数即可。**symlink 安装,改完命令立即生效,不用重装**。

### 新加一个命令

1. 在根目录新建 `<name>.js`
2. import `{ cli, Strategy }`,调用 `cli({ site: 'buyin', name: 'xxx', ... })`
3. 跑 `opencli plugin update opencli-buyin` 让 OpenCLI 重新扫描
4. 验证 `opencli buyin --help` 看到新命令

### 修改 `opencli-plugin.json` 或加 `.ts` 文件

必须重新跑 `opencli plugin update opencli-buyin`(需要 `esbuild` 装在依赖里:`npm i -D esbuild`)。

### 卸载 / 重装

```bash
opencli plugin uninstall opencli-buyin
opencli plugin install file:///Users/tengxinde/Documents/Projects/Vue/opencli-buyin
```

## 反爬与合规边界

- **正常用法**:每小时跑几次,自用,**无风险**
- **会触发风控**:每分钟级别 + 24×7 + 高并发 → 滑块、IP 限速、账号封禁
- **session token 寿命**:估计 **5~30 分钟**(无官方文档,经验值)
- **联系方式字段已删除**(`high_light` / `sec_shop_mobile` / `sec_shop_wechat_id`,2026-06-01) —— 合规考虑,数据里**不再包含**商家私人微信/手机。如有补回需求,改 `products.js` 的 columns 和 mapping 即可,但**先确认合规边界**
- 百应 ToS **明面禁止**任何爬取,自用低频不被找麻烦,但**别期待法律保护**

## 服务器部署

不能直接搬到无桌面 Linux 服务器,因为依赖真实 Chrome + 扩展 + 登录态 cookie。

可行方案:
- **本机 + scheduled job**:Mac mini 当采集机,Python/Node 调度
- **headless Linux + Xvfb + Chrome with extension**:0.5~1 天配置,登录态维护痛苦

不要在云函数 / Docker 里裸跑,百应签名机制走不通。

## 项目结构

```
opencli-buyin/
├── _shared/
│   └── browser-fetch.js     # 同源 fetch + 错误处理
├── products.js              # INTERCEPT 商品列表(默认带批量详情,见 §3.5)
├── categories.js            # COOKIE 类目树
├── opencli-plugin.json      # 插件 manifest(name/version/opencli range)
├── package.json             # peerDep: @jackwener/opencli
├── README.md                # 用户文档
└── CLAUDE.md                # 本文件(AI 上下文)
```

## 给未来 AI 会话的建议

1. **不要在不读 README/CLAUDE 的情况下乱改文件** —— 这个仓库的 INTERCEPT 流程有几个非显然的踩坑点(SPA 路由保留 patch、两阶段 token、轻量+完整双响应),改之前看清楚
2. **优先扩字段映射,而不是新接口** —— `pack_detail` 响应里还有 `model.author_data` / `model.hot_content_data` / `model.shop_product_data` 等板块没暴露,加一列比新写命令成本低
3. **新接口必须 recon 后再写** —— 不要根据 URL 模式猜参数,百应签名机制下猜的几乎都是 -1025
4. **测试 token 时效要在 5 分钟内做完** —— token 过期了所有"必传性"测试结果都会被噪音污染
5. **改 INTERCEPT pattern 时注意 install 顺序** —— `installInterceptor` 多次调用会**只更新 pattern,patch 不重复装**(底层 guard),所以可以两阶段切 pattern

## 不要做的事

- ❌ 把 `node_modules/` / `chrome-profile/` / 含 cookie 的文件提交 git
- ❌ 给 `products.js` 加并发(同时滚多次 / 同时调多个 pack_detail) —— 百应会风控
- ❌ 把 `products.js` 的批量节奏参数 default 调低想"跑快点" —— 滑块/封号代价大于省下的几分钟
- ❌ 删除 `_shared/browser-fetch.js` 的错误码兜底,即使你觉得"用不到"
- ❌ 在 README 里贴真实账号截图 / 真实店铺数据(脱敏)
- ❌ 把 plugin 推到公开 GitHub 时附带 `~/.opencli/cache/` 内容

## 历史 commits 简述

```
7e96316 feat: add categories command, slim products columns
192b63b initial buyin adapter
```

(后续若有更多迭代,可以追加这里;或直接 `git log --oneline -10`)
