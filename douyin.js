import { cli, Strategy } from '@jackwener/opencli/registry';

/**
 * 读取「当前 opencli profile 对应的那台 Chrome」的百应(抖音)登录态 + 抖音账号信息。
 *
 * 和 selection accounts(Google 账号)配套:同一个 profile,accounts 给 Google 号,
 * 本命令给抖音号,runner 合并成 opencli id -> {google, douyin} 的对账表。
 *
 * 怎么判 + 怎么取:
 *   导航百应首页 dashboard:
 *     - 已登录 -> 停在 buyin.jinritemai.com/dashboard(title「达人首页」),
 *       右上角用户胶囊里有抖音头像(douyinpic/byteimg/tos-cn 图)+ 昵称;
 *     - 未登录 -> 跳到 www.douyinec.com 营销页 或 /mpa/account/login。
 *   头像取那张图的 src;昵称取头像所在胶囊 .btn-item-role-exch/.btn-item 的文本
 *   (实测就是纯昵称,如「云远」,不含导航文案)。
 */

const DASHBOARD = 'https://buyin.jinritemai.com/dashboard';

cli({
  site: 'selection',
  name: 'douyin',
  access: 'read',
  description:
    '读取当前 profile 的百应(抖音)登录态 + 抖音昵称/头像;配合 --profile 按 profileid 取数',
  domain: 'buyin.jinritemai.com',
  strategy: Strategy.UI, // 纯浏览器会话读取,不拦截/不假设业务 API
  columns: ['logged_in', 'nickname', 'avatar', 'url'],
  func: async (page) => {
    // 显式带 query 导航(与 domain 预导航根地址不同址,不会被拒)
    await page.goto(`${DASHBOARD}`);

    // dashboard 是 SPA,用户胶囊异步渲染;轮询:抓到胶囊=登录成功,跳登出页=未登录。
    // 注意:营销页(douyinec.com)上也有 byteimg 图,不能拿「随便一张图」当头像 ——
    // 必须限定在「登录后右上角才出现的用户胶囊 .btn-item-role-exch」里。
    let info = { loggedOut: false, onBuyin: false, avatar: '', nickname: '', url: '' };
    for (let i = 0; i < 15; i++) {
      info = await page.evaluate(`() => {
        const url = location.href;
        const onBuyin = /buyin\\.jinritemai\\.com/.test(url);
        const loggedOut = /douyinec\\.com/.test(url) || /\\/mpa\\/account\\/login/.test(url);
        // 头像:只认真正的抖音头像图(douyinpic.com / aweme-avatar),避开通知铃铛 svg、营销图
        const img = [...document.querySelectorAll('img')].find(
          (i) => /douyinpic\\.com|aweme-avatar/.test(i.currentSrc || i.src || ''));
        const avatar = img ? (img.currentSrc || img.src) : '';
        // 昵称:头像所在的用户胶囊 .btn-item-role-exch/.btn-item 的文本(纯昵称)
        const chip = img ? img.closest('.btn-item-role-exch, .btn-item') : null;
        const nickname = chip ? chip.textContent.trim() : '';
        return { onBuyin, loggedOut, avatar, nickname, url };
      }`);
      if (info.loggedOut || (info.onBuyin && info.avatar)) break;
      await page.wait({ time: 1 });
    }

    // 登录判据:是否跳出去 —— 停在百应域 = 已登录;跳到 douyinec/登录页 = 未登录。
    // 头像/昵称只是附带信息(偶尔渲染慢可能为空),不参与登录判断。
    const loggedIn = info.onBuyin && !info.loggedOut;
    return {
      logged_in: loggedIn,
      nickname: loggedIn ? info.nickname : '',
      avatar: loggedIn ? info.avatar : '',
      url: info.url,
    };
  },
});
