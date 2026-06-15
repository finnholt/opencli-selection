import { cli, Strategy } from '@jackwener/opencli/registry';

/**
 * 读取「当前 opencli profile 对应的那台 Chrome」里登录的 Google 账号。
 *
 * 这是同步链路的「取数」环节:opencli 的 profile = 一个 Browser Bridge Chrome
 * 上下文,命令带 --profile <id> 跑就落在那台 Chrome 的会话里。配合 runner
 * (sync-google-accounts.mjs)遍历 `opencli profile list`,就能产出
 * profileid -> Google 账号 的映射。
 *
 * 怎么读到账号:
 *   不读 Chrome 本地文件(路径跨平台、字段会变、部分加密,脆弱),也不打
 *   accounts.google.com/ListAccounts —— 那个端点要当同源 XHR 调,顶层导航直接 400。
 *   最稳的是:导航到已登录的 myaccount.google.com,读右上角账号按钮的 aria-label,
 *   它形如「Google 账号: <名字> (<邮箱>)」(英文 "Google Account: ..."),名字 + 邮箱
 *   都在里面;再以页面正文里的邮箱兜底。实测可用。
 *
 * 局限:只给当前激活的主账号(profile 该用哪个号,这就是答案)。浏览器里多登的
 *   其它账号要点开账号切换器才拿得到,脆弱,这里不做。
 */

cli({
  site: 'selection', // 沿用本插件单一 site;命令名自描述
  name: 'accounts',
  access: 'read',
  description:
    '读取当前 profile 的 Chrome 登录的 Google 账号(主账号);配合 --profile 按 profileid 取数',
  domain: 'myaccount.google.com',
  strategy: Strategy.UI, // 纯浏览器会话读取,不拦截/不假设业务 API
  columns: ['email', 'name', 'primary', 'valid'],
  func: async (page) => {
    // 显式导航到账号主页(带 hl/utm 参数,与 domain 预导航的根地址不同址,不会被拒)。
    // 这是当前 profile 登录账号明文展示的页面。
    await page.goto('https://myaccount.google.com/?hl=zh_CN&utm_source=OGB&utm_medium=act');

    // 账号信息异步渲染,刚导航完往往还没出来 —— 轮询等它。
    let acct = null;
    for (let i = 0; i < 12; i++) {
      acct = await page.evaluate(`() => {
        // 优先:账号按钮的 aria-label "Google 账号: <名字> (<邮箱>)" / 英文 "Google Account: ..."
        const nodes = document.querySelectorAll('a[href*="SignOutOptions"], [aria-label]');
        for (const n of nodes) {
          const label = n.getAttribute('aria-label') || '';
          const m = label.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})/);
          if (m) {
            // 名字:去掉括号里的邮箱、再去掉 "Google 账号:" / "Google Account:" 前缀
            const name = label.replace(/\\([^)]*\\)/, '').replace(/^[^:：]*[:：]/, '').trim();
            return { email: m[1], name };
          }
        }
        // 兜底:页面正文里的第一个邮箱(myaccount 页面会明文展示当前账号邮箱)
        const t = document.body ? document.body.innerText : '';
        const e = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
        return e ? { email: e[0], name: '' } : null;
      }`);
      if (acct && acct.email) break;
      await page.wait({ time: 1 }); // 纯 setTimeout 等 1s 再试
    }

    if (!acct || !acct.email) return []; // 未登录 / 读不到 -> 空,runner 标 no_account
    return [{ email: acct.email, name: acct.name || '', primary: true, valid: true }];
  },
});
