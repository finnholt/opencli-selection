import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

/**
 * 百应选品库商品列表 —— "为你推荐以下商品" 区块。
 *
 * 接口:POST https://buyin.jinritemai.com/pc/selection/common/material_list
 *   - 30 条 / 页,POST body 由页面 JS 内部构造(含 channel_id / search_id 等会话信息)
 *   - 直接 fetch 难以构造请求体 → 走 INTERCEPT
 *
 * 关键细节:
 *   - installInterceptor 的 fetch patch 只存活于当前 window;
 *     直接 page.goto(目标页) 会刷新页面把 patch 抹掉
 *   - 因此必须先进同源页面 → 装 patch → 用 SPA 路由(pushState+popstate)
 *     在不刷新的情况下切到选品库,patch 保留 → 首次接口 fire 也能被捕获
 *   - 想要更多数据 → autoScroll 触发后续分页接口
 */

const LANDING_URL = 'https://buyin.jinritemai.com/dashboard';
const TARGET_PATH = '/dashboard/merch-picking-library';
const CAPTURE_PATTERN = 'selection/common/material_list';
const ITEMS_PER_PAGE = 30;

cli({
  site: 'buyin',
  name: 'products',
  access: 'read',
  description: '百应选品库"为你推荐"商品列表(商品名/售价/佣金率/月销/ID/封面图)',
  domain: 'buyin.jinritemai.com',
  strategy: Strategy.INTERCEPT,
  args: [
    { name: 'limit', type: 'int', default: 30, help: '想要的商品总数(每滚一次 +30)' },
    { name: 'wait', type: 'int', default: 4, help: '每次滚动后等响应的秒数' },
  ],
  columns: ['name', 'price', 'commission_rate', 'month_sale', 'product_id', 'main_img', 'category'],
  func: async (page, args) => {
    const desired = Math.max(1, Number(args.limit) || ITEMS_PER_PAGE);
    const scrollsNeeded = Math.max(0, Math.ceil(desired / ITEMS_PER_PAGE) - 1);
    const waitSecs = Math.max(2, Number(args.wait) || 4);

    // 1. 先进同源页面(任意 buyin dashboard 页都可以)
    await page.goto(LANDING_URL);
    await page.wait(3);

    // 2. 在已加载页面上装监听器(此时 window.fetch 已稳定)
    await page.installInterceptor(CAPTURE_PATTERN);

    // 3. SPA 路由切换到选品库 —— 不刷新页面,patch 保留
    await page.evaluate(`() => {
      window.history.pushState({}, '', ${JSON.stringify(TARGET_PATH)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }`);

    // 4. 等首批 material_list 响应
    try {
      await page.waitForCapture(15);
    } catch (e) {
      throw new CommandExecutionError(
        'SPA 路由后没有捕获到 material_list。可能未登录百应,或者选品库路由对当前账号不可见。' +
        '请在浏览器里手动打开 https://buyin.jinritemai.com/dashboard/merch-picking-library 确认能看到商品。',
      );
    }

    // 5. 验证 SPA 切换确实成功了
    const currentPath = await page.evaluate('() => window.location.pathname');
    if (typeof currentPath === 'string' && !currentPath.includes('merch-picking-library')) {
      // 退路:如果 popstate 没让 SPA 路由生效,直接 goto(会丢 patch 但至少能跑)
      // 这里不做退路,先报错让用户知道
      throw new CommandExecutionError(
        `SPA 路由失败:当前路径仍是 ${currentPath}。百应路由可能不响应 popstate,需要换触发方式。`,
      );
    }

    // 6. 滚动触发更多分页
    for (let i = 0; i < scrollsNeeded; i++) {
      await page.scroll('down');
      await page.wait(waitSecs);
      try {
        await page.waitForCapture(waitSecs + 2);
      } catch {
        // 翻不下去就停(到底了)
        break;
      }
    }

    // 7. 取所有响应
    const captures = await page.getInterceptedRequests();
    const items = captures.flatMap((resp) => resp?.data?.summary_promotions ?? []);

    if (items.length === 0) {
      throw new EmptyResultError(
        'buyin products',
        '商品列表为空。已捕获到响应但 summary_promotions 为空,接口字段可能已变。',
      );
    }

    // 8. 去重(滚动会重复返回首屏数据)
    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = it.product_id ?? it.promotion_id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }

    return unique.slice(0, desired).map(mapProduct);
  },
});

function mapProduct(item) {
  const p = item.base_model?.product_info ?? {};
  const promo = item.base_model?.promotion_info ?? {};
  const market = item.base_model?.marketing_info ?? {};
  const cos = promo.cos_info?.cos ?? {};

  return {
    name: p.name ?? '',
    price: fenToYuan(market.price_desc?.price?.origin),
    commission_rate: round1(cos.cos_ratio?.origin),
    month_sale: p.month_sale?.origin ?? 0,
    product_id: item.product_id ?? '',
    main_img: p.main_img?.url_list?.[0] ?? '',
    category: p.category ?? null,
  };
}

function fenToYuan(fen) {
  if (fen == null) return 0;
  return Math.round(Number(fen)) / 100;
}

function round1(n) {
  if (n == null) return 0;
  return Math.round(Number(n) * 10) / 10;
}
