import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { browserFetch } from './_shared/browser-fetch.js';

/**
 * 百应选品库「为你推荐」搜索词列表。
 *
 * 接口固定返 10 条,包含:
 *   - text:      纯关键词(如 "速溶咖啡")
 *   - show_text: 带营销标签的展示文案(如 "热销超1.0万件:速溶咖啡")
 *
 * URL 上的 ewid/verifyFp/fp/msToken/a_bogus 都是反爬参数,
 * 同源 fetch 时由百应自家的 JS 拦截器自动注入,不需要手动构造。
 */

const PAGE_URL = 'https://buyin.jinritemai.com/dashboard/merch-picking-library';
const API_URL = 'https://buyin.jinritemai.com/pc/selection/search/query/recommend';

cli({
  site: 'buyin',
  name: 'recommend',
  access: 'read',
  description: '百应选品库"为你推荐"——推荐搜索词与热销关键词',
  domain: 'buyin.jinritemai.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'limit', type: 'int', default: 10, help: '返回条数(接口本身固定返 10 条)' },
  ],
  columns: ['rank', 'keyword', 'caption'],
  func: async (page, args) => {
    await page.goto(PAGE_URL);
    await page.wait(2);

    const data = await browserFetch(page, 'GET', API_URL);

    const items = data.data?.rec_list ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      throw new EmptyResultError(
        'buyin recommend',
        '推荐列表为空。确认已登录 buyin.jinritemai.com 并能访问选品库。',
      );
    }

    const limit = Math.max(1, Math.min(Number(args.limit) || 10, items.length));
    return items.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      keyword: item.text ?? '',
      caption: item.show_text ?? '',
    }));
  },
});
