import { cli, Strategy } from '@jackwener/opencli/registry';
import { writeFileSync } from 'node:fs';

/**
 * 百应扫码登录二维码抓取。
 *
 * 为什么是「截图裁剪」而不是读 DOM:
 *   二维码是个 <img class="qr-image" src="data:image/png;base64,…">,但它在
 *   open.douyin.com/qrconnect 的**跨域 iframe** 里。opencli Browser Bridge 是
 *   Chrome 扩展的 content script,host 权限不含 open.douyin.com → 注入不进那个 frame,
 *   `page.frames()` / `evaluateInFrame` 都枚举不到它,读不到 data URI。
 *   截图能拿到像素、绕开同源策略,是经 opencli 这条路唯一可行的办法。
 *
 * 为什么坐标不写死:
 *   二维码位置随窗口大小 / 缩放 / Retina 变化。每次都用 page.evaluate 现量
 *   iframe 的 getBoundingClientRect() + scroll 偏移 + devicePixelRatio,所以换屏不裁偏。
 *
 * 为什么用 CDP 裁剪而不是「整页截图 + 手工裁」:
 *   page.cdp('Page.captureScreenshot', { clip }) 让 Chrome **原生**只截那一块,
 *   clip 用 CSS 像素、scale 控分辨率 —— 不用引图像库、不用手算 DPR、不用解码 PNG。
 *
 * 「进程不退出才能扫码」与「同时把码推走」如何兼顾:
 *   二维码 token 绑在这张 live 页面的 iframe 上,页面一关 iframe 就停止轮询
 *   check_qrconnect,扫了也不触发登录。所以扫码期间命令**默认阻塞着保活页面**。
 *   而码本身在进保活循环**之前**就已经:① 写盘 --out ② 往 stderr 打一行
 *   `QR_READY {json}`(机读信号)。父进程后台跑本命令 + 监听 stderr/读文件,就能在
 *   进程不退出的同时立刻拿到码推到服务器。见 README「扫码登录二维码」。
 *
 * 默认 base64-first:--out 默认 ""(不落盘)、--base64 默认开 —— 服务端直接消费 data URI,
 *   不读文件、无落盘竞态。要文件再显式传 --out <path>。
 *
 * 保活:轮询 URL,离开 /mpa/account/login 即视为扫码成功(登录态 cookie 已落到该 profile)。
 * --refresh_every:保活期间每 N 秒重抓最新码(覆盖 --out 若有)并再打一条 QR_READY,抗过期。
 *   抖音二维码寿命约 **5 分钟**,所以默认 240s < 300s:每张码到期前必已换新,长 poll 也不留死码。
 */

const LOGIN_URL =
  'https://buyin.jinritemai.com/mpa/account/login?log_out=1&type=24';
const QR_IFRAME = 'iframe[src*=qrconnect]';

cli({
  site: 'selection',
  name: 'login',
  access: 'read',
  description:
    '抓百应扫码登录二维码(CDP 裁剪截图);默认保活页面等扫码,stderr 打 QR_READY 信号',
  domain: 'buyin.jinritemai.com',
  strategy: Strategy.UI, // 纯浏览器交互,不做 API 拦截/登录态假设(本命令就是登录前用的)
  args: [
    { name: 'out', default: '', help: '二维码 PNG 保存路径;默认 ""(不落盘,只走 base64)。需要文件才传路径' },
    { name: 'base64', type: 'bool', default: true, help: '输出 qr_base64(data:image/png;base64 URI,也带进 QR_READY 信号);默认开,服务端直接消费' },
    { name: 'timeout', type: 'int', default: 600, help: '保活页面等待扫码上限(秒);抖音二维码寿命约 5 分钟,配 --refresh_every 跨多张码续命' },
    { name: 'refresh_every', type: 'int', default: 240, help: '保活期间每 N 秒重抓最新二维码并再打一条 QR_READY(抗 5 分钟过期;0=关)。默认 240 < 300 保证每张码到期前已换新' },
    { name: 'scale', type: 'int', default: 0, help: '截图渲染倍数(0=默认 dpr×2,Retina≈4x;调高更清晰但体积更大)' },
  ],
  columns: ['status', 'qr_base64'],
  func: async (page, args) => {
    const sleep = (secs) => page.wait({ time: secs }); // 纯 setTimeout(见 products.js 注释)

    await page.goto(LOGIN_URL);

    // ── 首次抓码:等 iframe 出现 + 二维码真的画出来 ──
    const first = await captureQR(page, args, sleep, 20);
    if (first.status !== 'ok') {
      // 没拿到可扫的码:若页面已离开登录页 = 这个 profile 本来就登录着,算成功;
      // 否则(还在登录页却抓不到码:截图失败 / 只截到空白卡)才是真抓码失败
      const u = await liveUrl(page);
      const already = u && !/\/mpa\/account\/login/.test(u) && !/^about:blank/.test(u);
      return [row(already ? 'logged_in' : 'no_qr', '')];
    }
    let b64 = first.b64;

    // ── 阻塞保活页面,等扫码完成;可选定时重抓最新码(始终执行) ──
    let loggedIn = false;
    let url = await currentUrl(page);
    {
      const deadline = Date.now() + Math.max(1, Number(args.timeout) || 180) * 1000;
      const refreshEvery = Math.max(0, Number(args.refresh_every) || 0);
      let nextRefresh = refreshEvery > 0 ? Date.now() + refreshEvery * 1000 : Infinity;
      while (Date.now() < deadline) {
        await sleep(3);
        // 必须用 liveUrl(每次真发 evaluate),不能用 currentUrl/getCurrentUrl:
        //   ① getCurrentUrl 命中 goto 时缓存的 _lastUrl,永远返回登录页 URL → 检测不到登录成功
        //   ② page.wait({time}) 是纯 Node setTimeout,不碰扩展;若保活期间一条命令都不发,
        //      adapter tab 的 ~30s idle 计时器会把窗口关掉(就是「窗口只存活 30s」的根因)。
        //   这条 evaluate 一举两得:拿真实 URL + 当心跳重置扩展 idle 计时器保活页面。
        url = await liveUrl(page);
        if (url && !/\/mpa\/account\/login/.test(url) && !/^about:blank/.test(url)) {
          loggedIn = true;
          break;
        }
        if (Date.now() >= nextRefresh) {
          const r = await captureQR(page, args, sleep, 3); // 重抓最新码(内含非空白校验)
          if (r.b64) b64 = r.b64; // 抓失败就保留旧码,不让单次抖动毁掉
          nextRefresh = Date.now() + refreshEvery * 1000;
        }
      }
    }

    return [row(loggedIn ? 'logged_in' : 'timeout', b64)];
  },
});

// 现量二维码 iframe 位置(轮询 attempts 次,每次间隔 1s);返回文档坐标 + dpr,失败返回 null
async function measureRect(page, attempts, sleep) {
  for (let i = 0; i < attempts; i++) {
    await sleep(1);
    const rect = await page.evaluate(`() => {
      const f = document.querySelector('${QR_IFRAME}');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return null; // 还没布局好
      return {
        x: r.x + window.scrollX,           // 转成文档坐标(CDP clip 用文档坐标系)
        y: r.y + window.scrollY,
        w: r.width,
        h: r.height,
        dpr: window.devicePixelRatio || 1,
      };
    }`);
    if (rect) return rect;
  }
  return null;
}

// 二维码画好的判据:字节/像素密度。二维码图是跨域 iframe **异步**画的 ——
// iframe 盒子先出现、码后画,过早截会得到空白卡片(实测空白卡 ~0.01 B/px,真码 ~0.2 B/px)。
// 跨域读不到内容,只能用这个密度信号判断「画出来了没」。
const MIN_QR_BPP = 0.04; // 落在空白(0.01)和真码(0.2)之间,4× 余量

// 量位置 → 反复截到「非空白」为止 → 写盘 → 打 QR_READY。
// 返回 { status: 'ok'|'no_qr', b64 }:只要没拿到「画出来的真码」(iframe 缺失 / 截图失败 /
// 只截到空白卡)一律按 'no_qr' 统一上报;'ok' 才是可扫的码。
async function captureQR(page, args, sleep, iframeAttempts) {
  const rect = await measureRect(page, iframeAttempts, sleep);
  if (!rect) return { status: 'no_qr', b64: null };

  // 默认按设备 dpr 的 2 倍渲染(Retina→4x,普通屏→2x),让二维码更清晰、扫码更稳;
  // --scale >0 时用显式值覆盖。再高收益递减(源是位图)且 PNG 体积变大。
  const scale = Number(args.scale) > 0 ? Number(args.scale) : Math.max(2, rect.dpr * 2);
  const area = Math.max(1, Math.round(rect.w * scale) * Math.round(rect.h * scale));

  let good = null, last = null;
  for (let i = 0; i < 12; i++) {
    const shot = await clipShot(page, rect, scale);
    if (shot) {
      last = shot;
      if (Buffer.byteLength(shot, 'base64') / area >= MIN_QR_BPP) { good = shot; break; }
    }
    await sleep(1); // 还是空白(或截图抖动),等 1s 再截
  }

  // 没截到、或只截到空白卡 —— 都按抓码失败处理(空白码也扫不了),统一 'no_qr'
  if (!good) return { status: 'no_qr', b64: null };
  if (args.out) writeFileSync(args.out, Buffer.from(good, 'base64')); // out 留空则不落盘
  emitReady(args, good);
  return { status: 'ok', b64: good };
}

// 机读信号:截好码的瞬间往 stderr 打一行,父进程不用轮询文件就知道码已就绪。
// 走 stderr,不污染 stdout 的最终结果(-f json 仍可干净解析)。
function emitReady(args, b64) {
  const sig = {
    path: args.out || '',
    bytes: Buffer.byteLength(b64, 'base64'),
    ts: Date.now(),
  };
  if (args.base64) sig.base64 = `data:image/png;base64,${b64}`; // 要 inline 才带(否则 ~180KB 刷屏)
  try {
    process.stderr.write('QR_READY ' + JSON.stringify(sig) + '\n');
  } catch {
    /* 信号尽力而为,失败不影响主流程 */
  }
}

// 统一组装输出行
function row(status, b64) {
  return {
    status,
    qr_base64: b64 ? `data:image/png;base64,${b64}` : '',
  };
}

// CDP 原生裁剪:Chrome 只截 clip 那一块,失败则退回整页截图(不裁,至少有图)
async function clipShot(page, rect, scale) {
  try {
    const res = await page.cdp('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale },
    });
    const data = typeof res === 'string' ? res : res?.data ?? res?.result?.data;
    if (data) return data;
  } catch {
    // 落到下面的兜底
  }
  try {
    return await page.screenshot({ format: 'png' }); // 兜底:整页 base64
  } catch {
    return null;
  }
}

async function currentUrl(page) {
  try {
    if (page.getCurrentUrl) return await page.getCurrentUrl();
  } catch { /* 继续兜底 */ }
  try {
    return await page.evaluate('() => location.href');
  } catch {
    return null;
  }
}

// poll 循环专用:**绕开 getCurrentUrl 的 _lastUrl 缓存**,每次真发一条 evaluate。
// 既拿到 SPA 当前真实 URL(判断是否离开登录页),又作为心跳重置扩展的 idle 计时器保活页面。
async function liveUrl(page) {
  try {
    return await page.evaluate('() => location.href');
  } catch {
    // evaluate 失败(页面真没了/导航中)就退回缓存兜底,至少不抛
    return await currentUrl(page);
  }
}
