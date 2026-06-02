import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { browserFetch } from './_shared/browser-fetch.js';

/**
 * 百应选品库类目接口。
 *
 *   GET https://buyin.jinritemai.com/pc/selection/common/cate_info
 *       ?scene=PCSquareSearch
 *       &cate_type=1                         → 一级类目(17 项,短 ID)
 *       &cate_type=3&parent_id=<id>          → 该一级下的子级(长 ID)
 *
 *   选品广场类目树有三层:
 *     - Level 1 顶级 (cate_type=1, 短 id 如 "5") —— 来自 cate_type=1 的响应,扁平无 childs
 *     - Level 2 选品大类 (cate_type=3, 长 id) —— 来自 cate_type=3&parent_id=<level1> 的响应
 *     - Level 3 选品细类 (cate_type=3, 长 id) —— **API 把它 nested 在 level-2 的 childs 字段里直接返回**
 *
 *   也就是说,拉一次 cate_type=3&parent_id=<top> 就能拿到 level-2 + level-3 整棵子树,
 *   不需要为每个 level-2 再发一次请求。
 *
 * 默认行为:返回 17 个顶级,每行附带 childs 字段(该顶级下的所有子级)。
 * --parent 指定父级 id:只返该父级下的子级,不再嵌套。
 * --flat:把树拍平成行,带 parent_id / parent_name 列,适合导 CSV。
 */

const PAGE_URL = 'https://buyin.jinritemai.com/dashboard/merch-picking-library';
const API_BASE = 'https://buyin.jinritemai.com/pc/selection/common/cate_info';

cli({
  site: 'buyin',
  name: 'categories',
  access: 'read',
  description: '百应选品库类目树(默认:顶级 + childs;--parent x:单级;--flat:拍平)',
  domain: 'buyin.jinritemai.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'parent', help: '上级类目 id(填了只拉该父级下的子级)' },
    { name: 'flat', type: 'bool', default: false, help: '把树拍平,每行带 parent_id / parent_name' },
    { name: 'sleep', type: 'int', default: 500, help: '抓子级时每次请求之间的延迟 ms(防风控)' },
  ],
  columns: ['id', 'name', 'cate_type', 'parent_id', 'parent_name', 'childs'],
  func: async (page, args) => {
    await page.goto(PAGE_URL);
    await page.wait(2);

    // ── 模式 1:--parent <id> 单级查询。API 自己返了 childs,直接透传 ──
    if (args.parent) {
      const items = await fetchCategories(page, { cate_type: 3, parent_id: args.parent });
      if (items.length === 0) {
        throw new EmptyResultError(
          'buyin categories',
          `parent_id=${args.parent} 下没有子类目`,
        );
      }
      return items.map((c) => ({
        id: c.id,
        name: c.name,
        cate_type: c.cate_type,
        parent_id: String(args.parent),
        parent_name: '',
        childs: c.childs ?? c.children ?? c.sub_cate_info ?? [],
      }));
    }

    // ── 模式 2:默认 / --flat 全量树 ───────────────────────────
    const tops = await fetchCategories(page, { cate_type: 1 });
    if (tops.length === 0) {
      throw new EmptyResultError('buyin categories', '一级类目为空');
    }

    const sleepMs = Math.max(0, Number(args.sleep) || 200);
    const tree = [];
    for (const t of tops) {
      let childs = [];
      try {
        const subs = await fetchCategories(page, { cate_type: 3, parent_id: t.id });
        childs = subs.map((s) => ({
          id: s.id,
          name: s.name,
          cate_type: s.cate_type,
          childs: s.childs ?? s.children ?? s.sub_cate_info ?? [],
        }));
      } catch {
        // 某个顶级拉子级失败就跳过,不让单点故障毁掉整棵树
      }
      tree.push({
        id: t.id,
        name: t.name,
        cate_type: t.cate_type,
        childs,
      });
      if (sleepMs > 0) await page.wait(sleepMs / 1000);
    }

    // ── --flat:把树拍平,childs 全部清空,每个子级提到独立行 ───
    if (args.flat) {
      const flat = [];
      for (const top of tree) {
        flat.push({ ...top, childs: [] });
        for (const c of top.childs) {
          flat.push({
            id: c.id,
            name: c.name,
            cate_type: c.cate_type,
            parent_id: top.id,
            parent_name: top.name,
            childs: [],
          });
        }
      }
      return flat;
    }

    return tree;
  },
});

async function fetchCategories(page, params) {
  const qs = new URLSearchParams({
    scene: 'PCSquareSearch',
    cate_type: String(params.cate_type),
    ...(params.parent_id ? { parent_id: String(params.parent_id) } : {}),
  });
  const data = await browserFetch(page, 'GET', `${API_BASE}?${qs.toString()}`);
  return data?.data?.cate_info ?? [];
}
