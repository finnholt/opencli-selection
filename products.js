import {cli, Strategy} from '@jackwener/opencli/registry';
import {CommandExecutionError, EmptyResultError} from '@jackwener/opencli/errors';
import {writeFileSync} from 'fs';

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
 */

const LANDING_URL = 'https://buyin.jinritemai.com/dashboard';
const LIST_PATH = '/dashboard/merch-picking-library';
const DETAIL_PATH = '/dashboard/merch-picking-library/merch-promoting';

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
    ],
    columns: [
        'promotion_id',
        'product_id',
        'title',
        'category',
        'sales_num',
        "media",
        'cover',
        'price',
        'old_price',
        'commission_rate',
        'good_ratio',
        'detail_url',
        'images',
        'big_imgs',
        "author_num",
        "stat_data",
        'calculate_data',
        "calculate_data_list",
        'detail_ok',
    ],
    func: async (page, args) => {
        const desired = Math.max(1, Number(args.limit) || ITEMS_PER_PAGE);
        const waitSecs = Math.max(2, Number(args.wait) || 6);
        const delayMs = Math.max(0, Number(args.delay) || 4000);
        const jitterMs = Math.max(0, Number(args.jitter) || 2000);
        const pauseEvery = Math.max(0, Number(args.pause_every) || 0);
        const pauseMs = Math.max(0, Number(args.pause_ms) || 0);

        // ─── 阶段 1: 进入选品库,抓 list + token ────────────────────────
        await page.goto(LANDING_URL);
        await page.wait(3);
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
                results.push(buildRow(item, null, null, '', false));
                continue;
            }

            // 周期性刷 token
            if (successCount > 0 && successCount % TOKEN_REFRESH_EVERY === 0) {
                const refreshed = await refreshTokens(page, waitSecs);
                if (refreshed) tokens = refreshed;
                await page.installInterceptor(PATTERN_DETAIL);
                processedIdx = (await page.getInterceptedRequests()).length;
            }

            // 触发 detail —— 方案 1+(强同步版):
            //   1. 切 interceptor 到 list pattern
            //   2. SPA 回列表,**等真实的 material_list 响应**(确认 React Router 真的处理完了)
            //   3. 切回 detail pattern,推进游标跳过 list 响应
            //   4. SPA 到详情,等 pack_detail
            //
            // 单纯 setTimeout 等不可靠,因为 React Router 可能把连续两次 pushState 合并处理,
            // 直接跳过"去列表"那步。等真实 list 响应 = 强制 React Router 走完"挂载列表"流程。
            const detailUrl = buildDetailUrl(productId, productId, tokens);

            await page.installInterceptor(PATTERN_LIST);
            await page.evaluate(`() => {
        window.history.pushState({}, '', ${JSON.stringify(LIST_PATH)});
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      }`);
            try {
                await page.waitForCapture(waitSecs);
            } catch {
                // 没等到也继续,但 stderr 标记一下
                process.stderr.write(`[warn] item ${i + 1}: 列表 material_list 没捕获到,继续\n`);
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

            const allCaps = await page.getInterceptedRequests();
            const newCaps = allCaps.slice(processedIdx);
            const startIdx = processedIdx;
            processedIdx = allCaps.length;

            // ─── 调试 dump:每条商品完整 capture 快照 ──────────────────────
            const dumpPath = `/tmp/buyin-caps-item-${String(i + 1).padStart(3, '0')}.json`;
            try {
                writeFileSync(dumpPath, JSON.stringify({
                    item_index: i + 1,
                    product_id: productId,
                    detail_url: detailUrl,
                    processed_idx_before: startIdx,
                    processed_idx_after: processedIdx,
                    total_caps: allCaps.length,
                    new_caps_count: newCaps.length,
                    new_caps: newCaps,
                    all_caps_keys_summary: allCaps.map((c, idx) => ({
                        idx,
                        code: c?.code,
                        msg: c?.msg,
                        dataKeys: Object.keys(c?.data ?? {}),
                        modelKeys: Object.keys(c?.data?.model ?? {}),
                        productKeys: Object.keys(c?.data?.model?.product ?? {}),
                        promotionKeys: Object.keys(c?.data?.model?.promotion_data ?? {}),
                        isList: !!(c?.data?.summary_promotions),
                        listCount: c?.data?.summary_promotions?.length ?? null,
                    })),
                }, null, 2));
                process.stderr.write(`  → dumped to ${dumpPath}\n`);
            } catch (e) {
                process.stderr.write(`  → dump 失败: ${e?.message ?? e}\n`);
            }

            const productHit = newCaps.find((c) => c?.data?.model?.product?.product_base);
            const promotionHit = newCaps.find((c) => c?.data?.model?.promotion_data?.calculate_data);

            // 调试日志:每条商品的 capture 数 + 是否命中
            process.stderr.write(
                `[item ${i + 1}/${targets.length}] pid=${productId} ` +
                `newCaps=${newCaps.length} ` +
                `hitProduct=${!!productHit} hitPromo=${!!promotionHit} ` +
                `productKeys=${productHit ? Object.keys(productHit.data?.model?.product ?? {}).join('|') : '-'}\n`
            );

            if (productHit) {
                results.push(buildRow(
                    item,
                    productHit.data.model.product,
                    promotionHit?.data?.model ?? null,
                    productId,
                    true,
                ));
                successCount++;
            } else {
                // 没拿到 product_base —— 可能 auth error 或别的失败,塞 list 字段就算了
                results.push(buildRow(item, null, null, productId, false));
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

function buildRow(listItem, productNode, promotion, productId, detailOk) {
    // 唯一从 list 取的字段:category(其余全部从 detail 取,detail 失败则为空/0)
    const category = listItem?.base_model?.product_info?.category ?? null;
    const month_sale = listItem?.base_model?.product_info?.month_sale?.origin ?? 0;

    const row = {
        product_id: productId || String(listItem?.product_id ?? ''),
        promotion_id:String(listItem?.promotion_id ?? ''),
        title: '',
        media: null,
        category,  // 分类
        month_sale:month_sale, // 月销
        sales_num:0, // 已售
        cover: '',
        price: 0,
        old_price: 0,
        author_num: "", // 带货人数
        commission_rate: 0, // 佣金
        good_ratio: 0, // 好评率
        detail_url: '',
        images: [],
        big_imgs: [],
        stat_data:null, // 饼图数据
        calculate_data:null, // 带货数据
        calculate_data_list:[], // 带货柱状图数据
        // is_sui_xin_tui: false,
        // is_in_window: false,
        // is_in_cart: false,
        detail_ok: !!detailOk,
    };

    if (!productNode) return row;

    const base = productNode.product_base ?? {};
    const priceLabel = productNode.product_price?.price_label ?? {};
    // const cosLabel = productNode.product_cos?.cos_label ?? {};
    // const cosMain = cosLabel.cos ?? {};
    const comment = productNode.product_comment ?? {};
    // const calc = promotion?.promotion_data?.calculate_data ?? {};

    row.title = base.title ?? '';
    row.media = base.media ?? null;
    row.cover = base.cover ?? '';
    row.detail_url = base.detail_url ?? '';
    row.images = base.images ?? [];
    row.big_imgs = base.big_imgs ?? [];


    row.price = priceLabel.price ?? 0;
    row.old_price = priceLabel.old_price ?? 0 ;


    row.sales_num = productNode?.product_sales?.product_label?.sales_num || 0;
    row.author_num = productNode?.product_match?.author_num || 0;

    row.good_ratio = comment.good_ratio ?? 0;
    row.commission_rate = productNode?.product_cos?.cos_label?.cos?.cos_ratio ?? 0;
    row.stat_data = promotion?.promotion_data?.stat_data || null;
    row.calculate_data = promotion?.content_data?.calculate_data || null;
    row.calculate_data_list = promotion?.content_data?.calculate_data_list || [];

    // row.is_sui_xin_tui = !!base.is_sui_xin_tui;
    // row.is_in_window = !!base.is_in_window;
    // row.is_in_cart = !!base.is_in_cart;
    return row;
}

function parseRatio(v) {
    if (v == null) return 0;
    const num = typeof v === 'string' ? parseFloat(v) : Number(v);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 10) / 10;
}
