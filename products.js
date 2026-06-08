import {cli, Strategy} from '@jackwener/opencli/registry';
import {CommandExecutionError, EmptyResultError} from '@jackwener/opencli/errors';

/**
 * 百应选品库商品列表(默认带完整详情)
 *
 * 流程:
 *   阶段 1: SPA 切到选品库 → 抓 material_list → 按需 scroll 凑齐 desired 条
 *           └─ 收集所有 product_id + list 字段
 *           └─ 取最新一份 search_id / session_id / log_pb
 *   阶段 2: 切 INTERCEPT pattern 到 pack_detail,逐条 SPA 到详情页抓
 *           └─ 每 TOKEN_REFRESH_EVERY 条主动刷一次 token(SPA 回列表)
 *           └─ 每条间隔 delay + jitter,每 pause_every 条插一个长停
 *           └─ 失败的条目只保留 list 字段(不中断整批)
 *           └─ 检测到 auth 错误(没有 product_base)自动刷 token,下一条继续
 *
 * 耗时参考(默认参数):
 *   30 条  ~3-5 分钟
 *   90 条  ~10-15 分钟
 *   200 条 ~25-40 分钟,极易触发风控,不建议
 *
 * 注意:批量带详情命中风控概率非高,默认节奏已尽量拟人,但**没有零风险方案**。
 *
 * 类目过滤(--category):
 *   material_list 是 POST + a_bogus 签名,我们没法手写整个 body。但 INTERCEPT
 *   已经 patch 过 window.fetch,所以在 installInterceptor **之前** 再插一层
 *   body 改写器,只动 material_list 的 POST body,把 filters.{BusinessCid|MendelCid}
 *   塞进去 —— 签名仍由浏览器算,不破坏。
 *
 *   id 短 (len < 7) → BusinessCid (cate_type=1 顶级,如 "5")
 *   id 长 (len >=7) → MendelCid   (cate_type=3 子级,如 "1000003462")
 *
 *   多个 id 用逗号分隔;同 key 多值放进数组,跨 key 也支持叠加。
 *
 * 区间过滤(--sales / --price / --commission):
 *   走同一套 body 改写。值由用户整段传区间字符串(如 R:5000,- / R:50,100),
 *   **不做 split**(区间格式自带逗号),原样包成 filters[key] = { value: [<raw>] }。
 *     --sales      → alliance_sales_30d  月销
 *     --price      → Price               售价(单位元,跟 UI 一致,非分)
 *     --commission → CosRatio            佣金率(百分比,如 40 = 40%)
 *   可与 --category 叠加。
 */

const LANDING_URL = 'https://buyin.jinritemai.com/dashboard';
const LIST_PATH = '/dashboard/merch-picking-library';
const DETAIL_PATH = '/dashboard/merch-picking-library/merch-promoting';
// 逐条详情之间的「路由重置」中转页。详情路由只变 query 不变 pathname,React Router
// 当成同一路由 → 详情组件不 remount → 不重发 pack_detail。必须先跳到一个不同 pathname
// 的路由把详情组件卸载掉。用「违规中心」而非选品库:它走 governance 接口面,完全不碰
// material_list,不给选品广场风控加计数。裸路径即可,universal_page_params_id 由 React 自动补。
const INTERIM_PATH = '/dashboard/content/author-violation';
const INTERIM_MOUNT_TEXT = '违规中心'; // 中转页 mount 完成的 DOM 信号(抗缓存,且 await 它防 React 合并 pushState)

const PATTERN_LIST = 'selection/common/material_list';
const PATTERN_DETAIL = 'selection/decision/pack_detail';

const ITEMS_PER_PAGE = 30;
const TOKEN_REFRESH_EVERY = 25; // 接近 session 寿命下沿(5 分钟),提前刷

cli({
    site: 'buyin',
    name: 'products',
    access: 'read',
    description: '百应选品库商品(带完整详情,批量,逐条带 jitter 抓 pack_detail)',
    domain: 'buyin.jinritemai.com',
    strategy: Strategy.INTERCEPT,
    args: [
        {name: 'limit', type: 'int', default: 30, help: '想要的商品总数(超过 30 会滚动列表)'},
        {name: 'wait', type: 'int', default: 6, help: '每个请求等响应的秒数(超时基数)'},
        {name: 'delay', type: 'int', default: 4000, help: '每条详情之间的延迟 ms(主防风控参数)'},
        {name: 'jitter', type: 'int', default: 2000, help: '延迟的随机抖动 ms(拟人节奏)'},
        {name: 'pause_every', type: 'int', default: 5, help: '每 N 条插一次长停(0=关闭)'},
        {name: 'pause_ms', type: 'int', default: 8000, help: '长停的毫秒数'},
        {name: 'interim_dwell', type: 'int', default: 3000, help: '中转页(违规中心)mount 后停留 ms(拟人浏览,跳详情前)'},
        {
            name: 'category',
            default: '',
            help: '类目 id,多个用逗号分隔(短 id→顶级 BusinessCid,长 id→子级 MendelCid,自动识别)'
        },
        {name: 'sales', default: '', help: '月销筛选(alliance_sales_30d),整段区间值,如 R:5000,-(≥5000)'},
        {name: 'price', default: '', help: '售价筛选(Price,单位元),整段区间值,如 R:50,100'},
        {name: 'commission', default: '', help: '佣金率筛选(CosRatio,百分比),整段区间值,如 R:40,50'},
    ],
    columns: [
        'promotion_id',
        'product_id',
        'title',
        'category',
        'sales_num',
        'cover',
        'price',
        'old_price',
        'commission_rate',
        'good_ratio',
        'detail_url',
        'images',
        'big_imgs',
        "author_num",
        "promotion_stat_data_list",
        "promotion_calculate_data",
        "content_calculate_data",
        "content_calculate_data_list",
        'audience_analysis',
        'sale_content_list',
        'detail_ok',
    ],
    func: async (page, args) => {
        const desired = Math.max(1, Number(args.limit) || ITEMS_PER_PAGE);
        const waitSecs = Math.max(2, Number(args.wait) || 6);
        const delayMs = Math.max(0, Number(args.delay) || 4000);
        const jitterMs = Math.max(0, Number(args.jitter) || 2000);
        const pauseEvery = Math.max(0, Number(args.pause_every) || 0);
        const pauseMs = Math.max(0, Number(args.pause_ms) || 0);
        const interimDwellMs = Math.max(0, Number(args.interim_dwell) || 0);

        const filterSpec = buildFilterSpec(args);
        if (filterSpec) {
            process.stderr.write(`[filter] ${describeFilterSpec(filterSpec)}\n`);
        }

        // ─── 阶段 1: 进入选品库,抓 list + token ────────────────────────
        await page.goto(LANDING_URL);
        await page.wait(3);
        if (filterSpec) {
            // 必须在 installInterceptor 之前,这样 interceptor 的 fetch patch
            // 会叠在我们的 body 改写器之上,触发时:
            //   React → interceptor 记录 → 我们改 body → 原生 fetch 签名发出
            await installFilters(page, filterSpec);
        }
        await page.installInterceptor(PATTERN_LIST);
        await page.evaluate(`() => {
      window.history.pushState({}, '', ${JSON.stringify(LIST_PATH)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }`);
        try {
            await page.waitForCapture(waitSecs * 2);
        } catch {
            throw new CommandExecutionError(
                'SPA 路由后没有捕获到 material_list。可能未登录或选品库对当前账号不可见。' +
                '请在浏览器手动打开 https://buyin.jinritemai.com/dashboard/merch-picking-library 确认。',
            );
        }

        if (filterSpec) {
            const status = await readFilterPatchStatus(page);
            process.stderr.write(`[filter] patch status: ${JSON.stringify(status)}\n`);
            if (status && status.hits && status.hits.fetch === 0 && status.hits.xhr === 0) {
                process.stderr.write(
                    '[filter] 警告:patch 没有命中任何 material_list 请求 —— ' +
                    '筛选可能未生效,返回的还是默认池。\n',
                );
            }
        }

        const scrollsNeeded = Math.max(0, Math.ceil(desired / ITEMS_PER_PAGE) - 1);
        for (let i = 0; i < scrollsNeeded; i++) {
            await page.scroll('down');
            await page.wait(waitSecs);
            try {
                await page.waitForCapture(waitSecs);
            } catch {
                break; // 翻不下去就停
            }
        }

        const listCaptures = await page.getInterceptedRequests();
        const listItems = dedupListItems(
            listCaptures.flatMap((r) => r?.data?.summary_promotions ?? [])
        );
        if (listItems.length === 0) {
            throw new EmptyResultError(
                'buyin products',
                '商品列表为空。已捕获响应但 summary_promotions 为空,接口字段可能已变。',
            );
        }

        let tokens = extractLatestTokens(listCaptures);
        if (!tokens) {
            throw new CommandExecutionError('material_list 响应里没有可用 token (search_id 缺失)');
        }

        // ─── 阶段 2: 切 detail pattern,逐条抓详情 ──────────────────────
        await page.installInterceptor(PATTERN_DETAIL);
        let processedIdx = (await page.getInterceptedRequests()).length;

        const targets = listItems.slice(0, desired);
        const results = [];
        let successCount = 0;

        for (let i = 0; i < targets.length; i++) {
            const item = targets[i];
            const productId = String(item.product_id ?? '');
            if (!productId) {
                results.push(buildRow(item, null, null, null, null, '', false));
                continue;
            }

            // 周期性刷 token
            if (successCount > 0 && successCount % TOKEN_REFRESH_EVERY === 0) {
                const refreshed = await refreshTokens(page, waitSecs);
                if (refreshed) tokens = refreshed;
                await page.installInterceptor(PATTERN_DETAIL);
                processedIdx = (await page.getInterceptedRequests()).length;
            }

            // 触发 detail —— 方案 2(轻量中转 + DOM 确认版):
            //   1. SPA 跳「违规中心」中转页(pathname 变 → React 卸载详情组件)
            //   2. 轮询等「违规中心」DOM 出现(确认 React Router 真的 mount 了中转页;
            //      await 它 = 防止连续两次 pushState 被 React 合并,跳过中转那步)
            //   3. 切 detail pattern,推进游标
            //   4. SPA 到详情,等 pack_detail
            //
            // 旧版用「回选品库 + 等 material_list 响应」当确认信号,代价是每条多发一个带签名的
            // material_list POST(给选品广场风控加计数)。违规中心走 governance 接口面,不碰
            // material_list,且 DOM 信号比等请求更快、抗缓存。token 刷新仍走选品库(见 refreshTokens)。
            const detailUrl = buildDetailUrl(productId, productId, tokens);

            await page.evaluate(`() => {
        window.history.pushState({}, '', ${JSON.stringify(INTERIM_PATH)});
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      }`);
            const interimReady = await waitForInterimMount(page, waitSecs);
            if (!interimReady) {
                // 没确认到中转页 mount,继续(下一步详情 pushState 仍可能成功),但标记一下
                process.stderr.write(`[warn] item ${i + 1}: 中转页(${INTERIM_MOUNT_TEXT})未确认 mount,继续\n`);
            }

            // 在中转页停留一会儿再跳详情 —— 拟人浏览节奏,避免"瞬切"指纹。
            // 复用 jitter 做随机抖动,停留区间 [interimDwell, interimDwell+jitter]。
            if (interimDwellMs > 0) {
                const dwell = interimDwellMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
                await page.wait(dwell / 1000);
            }

            await page.installInterceptor(PATTERN_DETAIL);
            processedIdx = (await page.getInterceptedRequests()).length;

            await page.evaluate(`() => {
        window.history.pushState({}, '', ${JSON.stringify(detailUrl)});
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      }`);

            let firstCaptured = false;
            try {
                await page.waitForCapture(waitSecs * 2);
                firstCaptured = true;
            } catch {
                // 完全超时
            }
            // 给"完整版" pack_detail 多等一会儿(React 可能分两次发)
            await page.wait(2);

            // 触发 audience_analysis_data 响应:
            //   React 把 SPA 进详情页时复用了上次的 tab state,
            //   直接 click 受众 tab 不会触发 state change → 不 fetch。
            //   修法:click 默认"带货数据"tab → 等 0.6s → click 受众 tab。
            //   tab 组件挂载晚于 pack_detail 响应,所以要先 check + 必要时 wait。
            //   ⚠️ 不在 evaluate 内部 await setTimeout,因为 page.evaluate 接字符串时
            //   不保证 await 被外层消化 —— 改成外面 page.wait 拆 3 步。
            const audienceTabReady = await page.evaluate(`() => {
        if (document.getElementById('rc-tabs-0-tab-audience_data')) return true;
        for (const t of document.querySelectorAll('[role=tab]')) {
          if ((t.textContent || '').trim() === '受众数据') return true;
        }
        return false;
      }`);

            let audienceClickResult = null;
            if (!audienceTabReady) {
                await page.wait(2);
            }

            // Step 1: 点默认"带货数据"tab(toggle 用)
            // ⚠️ 不用 el.click() —— 在 page.evaluate 通路里,React 合成事件
            //   可能拿不到。改用 dispatchEvent 派发完整的 mousedown+mouseup+click
            //   序列,更贴近真实用户交互。
            //
            // ⚠️ 不用写死 rc-tabs-0-tab-data —— React 重新 mount Tabs 后
            //   counter 会递增(rc-tabs-1, rc-tabs-2...)。从当前可见的
            //   audience tab 出发,在同一个 tablist 容器里找 data tab,
            //   保证不点到 DOM 残留的旧实例。
            const step1 = await page.evaluate(`() => {
        const fire = (el) => {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        };
        // 先找受众 tab(为了定位同一个 tablist 容器)
        const aud = [...document.querySelectorAll('[role=tab]')].find(t => (t.textContent||'').trim() === '受众数据');
        if (!aud) return { ok: false, reason: 'audience_tab_not_found_for_locate' };
        const tablist = aud.closest('[role=tablist]') || aud.parentElement?.parentElement;
        if (!tablist) return { ok: false, reason: 'tablist_not_found' };
        const dataTab = [...tablist.querySelectorAll('[role=tab]')].find(t => (t.textContent||'').trim() === '带货数据');
        if (!dataTab) return { ok: false, reason: 'data_tab_not_found' };
        fire(dataTab);
        return { ok: true, id: dataTab.id || null };
      }`);

            if (step1?.ok) {
                // Step 2: 等 React 处理 tab 切换
                //   原来固定 0.6s —— 太快且零抖动,是最像脚本的一段。
                //   加大到 1.5~2.5s 随机,打散规律节奏(拟人,缓解限流指纹)。
                await page.wait(1.5 + Math.random());

                // Step 3: 点"受众数据"tab(同样在同一个 tablist 里找)
                audienceClickResult = await page.evaluate(`() => {
          const fire = (el) => {
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
          };
          const aud = [...document.querySelectorAll('[role=tab]')].find(t => (t.textContent||'').trim() === '受众数据');
          if (!aud) return { clicked: false, reason: 'audience_tab_not_found' };
          fire(aud);
          return { clicked: true, id: aud.id || null };
        }`);
            } else {
                audienceClickResult = {clicked: false, reason: step1?.reason || 'step1_failed'};
            }

            if (audienceClickResult?.clicked) {
                try {
                    await page.waitForCapture(waitSecs);
                } catch {
                }
                // 受众 pack_detail 抓完 → 点带货内容前的间隔。这是一条里两次 pack_detail
                // 挨最近的地方,原来固定 1.5s 太突发。加大到 3~4.5s 随机,把 pack_detail
                // 速率摊开(缓解 11001 限流)。
                await page.wait(3 + Math.random() * 1.5);
            }

            // 追加点"带货内容"tab:
            //   audience 完成后 React state = 'audience_data',现在点 content
            //   就是 audience_data → content,本身就是 state 变化,不用再 toggle。
            //   click 方式同 audience,用 dispatchEvent 派发完整 mousedown+mouseup+click。
            let contentClickResult = null;
            if (audienceClickResult?.clicked) {
                contentClickResult = await page.evaluate(`() => {
          const fire = (el) => {
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
          };
          const target = [...document.querySelectorAll('[role=tab]')].find(t => (t.textContent||'').trim() === '带货内容');
          if (!target) return { clicked: false, reason: 'content_tab_not_found' };
          fire(target);
          return { clicked: true, id: target.id || null };
        }`);

                if (contentClickResult?.clicked) {
                    try {
                        await page.waitForCapture(waitSecs);
                    } catch {
                    }
                    // 带货内容 pack_detail 抓完 → 进条目间 delay 前的间隔。加大到 2.5~4s 随机。
                    await page.wait(2.5 + Math.random() * 1.5);
                }
            }

            const allCaps = await page.getInterceptedRequests();
            processedIdx = allCaps.length;

            // 不用 newCaps slice —— buffer 游标会被 installInterceptor 切 pattern 时的
            // 清空时机错位(偶数项 before=1 漏一条)。直接在 allCaps 里按响应自带的
            // data.product_id 匹配当前 productId,稳。
            //   - 完整版:含 product_base
            //   - 轻量版:只有 product_risk_tip,但 promotion_data 往往在轻量版里
            const matched = allCaps.filter((c) => String(c?.data?.product_id ?? '') === productId);
            const productHit = matched.find((c) => c?.data?.model?.product?.product_base);
            const promotionHit = matched.find((c) => c?.data?.model?.promotion_data?.calculate_data);
            const audienceHit = matched.find((c) => c?.data?.model?.audience_analysis_data);
            const contentHit = matched.find((c) => c?.data?.model?.sale_content_data?.content_list);

            if (productHit) {
                results.push(buildRow(
                    item,
                    productHit.data.model.product,
                    promotionHit?.data?.model ?? null,
                    audienceHit?.data?.model ?? null,
                    contentHit?.data?.model ?? null,
                    productId,
                    true,
                ));
                successCount++;
            } else {
                // 没拿到 product_base —— 可能 auth error 或别的失败,塞 list 字段就算了
                results.push(buildRow(item, null, null, null, null, productId, false));
                if (firstCaptured) {
                    // 有响应但没 product_base,大概率 token 过期 —— 主动刷
                    const refreshed = await refreshTokens(page, waitSecs);
                    if (refreshed) tokens = refreshed;
                    await page.installInterceptor(PATTERN_DETAIL);
                    processedIdx = (await page.getInterceptedRequests()).length;
                }
            }

            // 节奏:延迟 + 抖动
            const sleepMs = delayMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
            if (sleepMs > 0) await page.wait(sleepMs / 1000);

            // 每 N 条长停
            if (pauseEvery > 0 && pauseMs > 0 && (i + 1) % pauseEvery === 0 && i + 1 < targets.length) {
                await page.wait(pauseMs / 1000);
            }
        }

        return results;
    },
});

// ──────────────────────────────────────────────────────────────────

function parseCategoryArg(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const ids = s.split(/[,\s]+/).filter(Boolean);
    if (ids.length === 0) return null;
    const businessIds = [];
    const mendelIds = [];
    for (const id of ids) {
        if (id.length >= 7) mendelIds.push(id);
        else businessIds.push(id);
    }
    return {businessIds, mendelIds};
}

// 区间维度的 filter key —— 值由用户整段传(如 R:5000,-),**不做 split**(区间格式自带逗号)。
const RANGE_FILTER_KEYS = {
    sales: 'alliance_sales_30d', // 月销
    price: 'Price',              // 售价(单位元)
    commission: 'CosRatio',      // 佣金率(百分比)
};

// 把 --category + --sales/--price/--commission 合成一份 filter spec(都没传则返回 null)。
function buildFilterSpec(args) {
    const cat = parseCategoryArg(args.category) || {businessIds: [], mendelIds: []};
    const ranges = {};
    for (const [argName, filterKey] of Object.entries(RANGE_FILTER_KEYS)) {
        const raw = String(args[argName] ?? '').trim();
        if (raw) ranges[filterKey] = raw; // 整段原样,不 split
    }
    const hasCat = cat.businessIds.length > 0 || cat.mendelIds.length > 0;
    const hasRanges = Object.keys(ranges).length > 0;
    if (!hasCat && !hasRanges) return null;
    return {businessIds: cat.businessIds, mendelIds: cat.mendelIds, ranges};
}

function describeFilterSpec(spec) {
    const parts = [];
    if (spec.businessIds.length) parts.push(`BusinessCid=${spec.businessIds.join(',')}`);
    if (spec.mendelIds.length) parts.push(`MendelCid=${spec.mendelIds.join(',')}`);
    for (const [k, v] of Object.entries(spec.ranges)) parts.push(`${k}=${v}`);
    return parts.join(' ') || '(空)';
}

async function installFilters(page, filter) {
    // 同时 patch fetch 和 XMLHttpRequest —— 百应的签名 SDK 大概率 hook XHR,
    // 走 axios 默认 adapter 时不经过 window.fetch。
    // 两层都装,谁中了算谁。命中后 window.__buyinFilterHits 自增,便于排查。
    const cfg = JSON.stringify(filter);
    await page.evaluate(`() => {
    window.__buyinFilters = ${cfg};
    if (window.__buyinFiltersPatched) return;
    window.__buyinFiltersPatched = true;
    window.__buyinFilterHits = { fetch: 0, xhr: 0, skipNonString: 0 };

    const MATCH = 'selection/common/material_list';

    function mutateBody(bodyStr) {
      try {
        const body = JSON.parse(bodyStr);
        body.filters = body.filters || {};
        const f = window.__buyinFilters || {};
        if (f.businessIds && f.businessIds.length) {
          body.filters.BusinessCid = { value: f.businessIds };
        }
        if (f.mendelIds && f.mendelIds.length) {
          body.filters.MendelCid = { value: f.mendelIds };
        }
        // 区间维度:每个 key 整段值包成 { value: [<raw>] },如 { value: ['R:5000,-'] }
        const ranges = f.ranges || {};
        for (const k in ranges) {
          body.filters[k] = { value: [ranges[k]] };
        }
        return JSON.stringify(body);
      } catch (_e) {
        return null;
      }
    }

    // ─── fetch ──────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf(MATCH) >= 0) {
          if (init && typeof init.body === 'string') {
            const mutated = mutateBody(init.body);
            if (mutated) {
              init.body = mutated;
              window.__buyinFilterHits.fetch++;
            }
          } else {
            window.__buyinFilterHits.skipNonString++;
          }
        }
      } catch (_e) {}
      return origFetch.call(this, input, init);
    };

    // ─── XMLHttpRequest ─────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__buyinUrl = String(url || '');
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        const url = this.__buyinUrl || '';
        if (url.indexOf(MATCH) >= 0) {
          if (typeof body === 'string') {
            const mutated = mutateBody(body);
            if (mutated) {
              window.__buyinFilterHits.xhr++;
              return origSend.call(this, mutated);
            }
          } else {
            window.__buyinFilterHits.skipNonString++;
          }
        }
      } catch (_e) {}
      return origSend.call(this, body);
    };
  }`);
}

async function readFilterPatchStatus(page) {
    try {
        return await page.evaluate(`() => ({
      patched: !!window.__buyinFiltersPatched,
      hits: window.__buyinFilterHits || null,
      filter: window.__buyinFilters || null,
    })`);
    } catch {
        return null;
    }
}

function dedupListItems(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        const key = it.product_id ?? it.promotion_id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
    }
    return out;
}

function extractLatestTokens(captures) {
    // 倒序找,取最新一份带 search_id 的 material_list 响应
    for (let i = captures.length - 1; i >= 0; i--) {
        const c = captures[i];
        const sid = c?.data?.extra?.search_id;
        if (sid) {
            return {
                searchId: sid,
                sessionId: c.data.extra.session_id ?? sid, // session_id 缺失时回退到 search_id
                logPb: c.data.log_id ?? '',
            };
        }
    }
    return null;
}

// 轮询等中转页(违规中心)mount 完成。比 waitForCapture 快、抗缓存,且 await 它能确保
// React Router 真的把中转路由 commit 了,从而保证下一步详情 pushState 不被合并跳过。
async function waitForInterimMount(page, maxSecs) {
    const deadline = Date.now() + Math.max(2, maxSecs) * 1000;
    while (Date.now() < deadline) {
        const ok = await page.evaluate(`() => {
      const t = ${JSON.stringify(INTERIM_MOUNT_TEXT)};
      return [...document.querySelectorAll('h1,h2,h3')].some((h) => (h.textContent || '').includes(t));
    }`);
        if (ok) return true;
        await page.wait(0.3);
    }
    return false;
}

async function refreshTokens(page, waitSecs) {
    await page.installInterceptor(PATTERN_LIST);
    const before = (await page.getInterceptedRequests()).length;
    await page.evaluate(`() => {
    window.history.pushState({}, '', ${JSON.stringify(LIST_PATH)});
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }`);
    try {
        await page.waitForCapture(waitSecs * 2);
    } catch {
        return null;
    }
    const after = await page.getInterceptedRequests();
    return extractLatestTokens(after.slice(before));
}

function buildDetailUrl(productId, commodityId, tokens) {
    const qs = new URLSearchParams({
        commodity_id: commodityId,
        id: commodityId,
        product_id: productId,
    });
    if (tokens.searchId) qs.set('search_id', tokens.searchId);
    if (tokens.sessionId) qs.set('session_id', tokens.sessionId);
    if (tokens.logPb) qs.set('log_pb', tokens.logPb);
    qs.set('decision_enter_from', 'pc.selection_square.recommend_main');
    return `${DETAIL_PATH}?${qs.toString()}`;
}

function buildRow(listItem, productNode, promotion, audienceModel, contentModel, productId, detailOk) {
    // 从 list 取的字段:category / month_sale / commission_rate
    // commission_rate 主商品的佣金率在 list 里的 base_model.promotion_info.cos_info
    // 就有(跟 shop_product_data 里同店商品的 cos_info 同形)。pack_detail 在我们
    // SPA 触发下经常返回精简版,product_cos = {} 是空的,所以不能只信 detail。
    const category = listItem?.base_model?.product_info?.category ?? null;
    const month_sale = listItem?.base_model?.product_info?.month_sale?.origin ?? 0;
    const listCosRatio = listItem?.base_model?.promotion_info?.cos_info?.cos?.cos_ratio?.origin ?? 0;

    const row = {
        product_id: productId || String(listItem?.product_id ?? ''),
        promotion_id: String(listItem?.promotion_id ?? ''),
        title: '',
        category,  // 分类
        month_sale: month_sale, // 月销
        sales_num: 0, // 已售
        cover: '',
        price: 0,
        old_price: 0,
        author_num: "", // 带货人数
        commission_rate: listCosRatio, // 佣金率(从 list 取,detail 经常空)
        good_ratio: 0, // 好评率
        detail_url: '',
        images: [],
        big_imgs: [],
        promotion_stat_data_list: [], // 饼图数据
        promotion_calculate_data: null, // 带货数据(统计)
        content_calculate_data: null,// 带货数据(类型)
        content_calculate_data_list: [], // 带货柱状图数据
        audience_analysis: [], // 受众数据(性别/年龄/地区/人群 4 维 raw 数组)
        sale_content_list: [],   // 带货达人/视频明细(达人+内容+销售+互动数据)
        detail_ok: !!detailOk,
    };

    if (audienceModel?.audience_analysis_data?.audience_analysis) {
        row.audience_analysis = audienceModel.audience_analysis_data.audience_analysis;
    }
    if (contentModel?.sale_content_data?.content_list) {
        row.sale_content_list = contentModel.sale_content_data.content_list;
    }

    if (!productNode) return row;

    const base = productNode.product_base ?? {};
    const priceLabel = productNode.product_price?.price_label ?? {};
    const comment = productNode.product_comment ?? {};

    row.title = base.title ?? '';
    row.cover = base.cover ?? '';
    row.detail_url = base.detail_url ?? '';
    row.images = base.images ?? [];
    row.big_imgs = base.big_imgs ?? [];


    row.price = priceLabel.price ?? 0;
    row.old_price = priceLabel.old_price ?? 0;


    row.sales_num = productNode?.product_sales?.product_label?.sales_num || 0;
    row.author_num = productNode?.product_match?.author_num || 0;

    row.good_ratio = comment.good_ratio ?? 0;
    // 如果 detail 这次确实有 cos_label(全量场景),用它覆盖 —— 一般覆盖不到,product_cos = {}
    const detailCosRatio = productNode?.product_cos?.cos_label?.cos?.cos_ratio;
    if (detailCosRatio != null) row.commission_rate = detailCosRatio;
    row.promotion_stat_data_list = promotion?.promotion_data?.stat_data?.promotion_stat_data_list || [];
    row.promotion_calculate_data = promotion?.promotion_data?.calculate_data || null;
    row.content_calculate_data = promotion?.content_data?.calculate_data || null;
    row.content_calculate_data_list = promotion?.content_data?.calculate_data_list || [];

    return row;
}

