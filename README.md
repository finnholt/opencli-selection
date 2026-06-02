# opencli-buyin

OpenCLI 插件 —— 抖音百应(选品广场)商家侧数据采集。

借助你本机 Chrome 已登录的百应账号,通过 OpenCLI 的 INTERCEPT/COOKIE 策略,把选品库的商品/类目/详情数据抓成结构化输出(JSON / CSV / Markdown / 表格)。

## 命令一览

| 命令 | 数据 | 策略 | 输出形态 |
|---|---|---|---|
| `opencli buyin products` | 选品库"为你推荐"商品列表(可滚动分页) | INTERCEPT | 多行,每行 1 个商品 |
| `opencli buyin product <id>` | 单个商品的完整详情(基础/佣金/视频/大图/亮点话术) | INTERCEPT(两阶段) | 单行,17 个字段 |
| `opencli buyin categories` | 选品库类目树(顶级 17 项 + 每个顶级下的子级) | COOKIE | 树形 / 拍平 |

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
```

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

### 商品详情

```bash
# 从 products 拿到 product_id 后查详情
opencli buyin product 3698435191010885821 --promotion 3698438561134163727

# 显式传 session token(跳过列表抓取,适合调试)
opencli buyin product 3698435191010885821 \
  --promotion 3698438561134163727 \
  --search_id "<160 字符>" \
  --session_id "<160 字符>" \
  --log_pb "<时间戳形态>"
```

#### 工作原理(两阶段)

1. **阶段 1**:进 `/dashboard` → SPA 切到 `/merch-picking-library` → 捕获 `material_list` 响应,从 `data.extra` 拿 `search_id` / `session_id` / `log_pb`
2. **阶段 2**:SPA 切到 `/merch-promoting?commodity_id=...&product_id=...&search_id=...&session_id=...&log_pb=...` → 捕获 `pack_detail` 响应

百应详情接口强制要求 session token,**不能裸调**(会返 `-1025`)。

#### 输出列(17 个)

| 列 | 来源 | 说明 |
|---|---|---|
| `product_id` | 入参 | — |
| `name` | `product_base.title` | 商品名 |
| `cover` | `product_base.cover` | 主图 |
| `video_url` | `product_base.media.video_url` | **带签名的临时链接,几小时失效** |
| `commission_rate` | `product_cos.cos_label.cos.cos_ratio` | 佣金率 % |
| `commission_fee` | `product_cos.cos_label.cos.cos_fee` | 佣金金额(元,分→元) |
| `commission_type` | `product_cos.cos_label.cos_ratio_text` | "团长" / "标准" |
| `good_ratio` | `product_comment.good_ratio` | 好评率 % |
| `fans_match_score` | `product_fans_match.fans_match.score` | 粉丝匹配度 0~100 |
| `fans_match_level` | `product_fans_match.fans_match.level` | 匹配等级 1~5 |
| `high_light` | `product_base.high_light` | **商家亮点话术**(常含微信号/手机号) |
| `detail_url` | `product_base.detail_url` | haohuo 消费侧详情页 |
| `images` | `product_base.images` | 营销图数组 |
| `big_imgs` | `product_base.big_imgs` | 详情大图数组 |
| `is_sui_xin_tui` | — | 支持随心推 |
| `is_in_window` | — | 已加橱窗 |
| `is_in_cart` | — | 已加选品车 |

`pack_detail` 响应里还有 `model.author_data`(合作达人列表)/ `model.hot_content_data`(热门带货视频)/ `model.shop_product_data`(同店其他商品)等板块,当前未映射,以后可扩。

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

## 字段约定

- **金额单位**:API 返回的 `price.origin` 和 `cos_fee.origin` 都是**分**,adapter 已转换成**元**
- **百分数**:API 返回的 `cos_ratio.origin = 10` 表示 **10%**,不是 0.10。Adapter 透传原值
- **时间戳**:API 内部用 `YYYYMMDDHHMMSSXXXX` 字符串(如 `log_pb` 字段)

## 已知限制

| 限制 | 原因 |
|---|---|
| 必须本机 Chrome 登录,无法服务器 headless 直跑 | 百应 a_bogus 签名靠浏览器自家 JS hook |
| 商品列表只能拉"为你推荐"池,无法按类目筛 | 当前 INTERCEPT 模式被动接收,未做主动 POST body 构造 |
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
├── products.js              # 商品列表(INTERCEPT)
├── product.js               # 商品详情(INTERCEPT,两阶段)
├── categories.js            # 类目树(COOKIE)
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
   - 显式传 `--search_id/--session_id/--log_pb` 可跳过阶段 1(批量查询时复用 token)

## License

Apache-2.0
