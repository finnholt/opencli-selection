import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

function isAuthLikeError(code, message) {
  const text = String(message ?? '');
  return code === 401 || code === 403 ||
    /login|cookie|auth|captcha|verify|forbidden|permission|登录|登陆|权限|验证|验证码|未授权/i.test(text);
}

/**
 * Run fetch() inside the same-origin jinritemai page so cookies and Douyin's
 * a_bogus/X-Bogus signing hook are applied automatically by the browser.
 *
 * Merchant/brand surface lives at fxg.jinritemai.com (抖店分销管理); the
 * talent-facing buyin.jinritemai.com shares cookies but the merchant APIs
 * live under fxg. Caller must have navigated to a *.jinritemai.com page
 * first; cross-origin calls miss signing/cookies.
 */
export async function browserFetch(page, method, url, options = {}) {
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${Number(options.timeoutMs ?? 30000)});
      try {
        const res = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...${JSON.stringify(options.headers ?? {})}
          },
          ${options.body ? `body: JSON.stringify(${JSON.stringify(options.body)}),` : ''}
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          return { code: res.ok ? -2 : res.status, msg: 'JSON parse failed: ' + (text.slice(0, 500) || String(error && error.message || error)) };
        }
      } catch (error) {
        return { code: -1, msg: String(error && error.message || error) };
      } finally {
        clearTimeout(timer);
      }
    })()
  `;
  let result;
  try {
    result = await page.evaluate(js);
  } catch (error) {
    throw new CommandExecutionError(
      `buyin API request failed (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    throw new CommandExecutionError(`Malformed response from buyin API (${method} ${url})`);
  }
  // buyin/jinritemai 常见错误码字段:code / st / status_code
  const code = result.code ?? result.st ?? result.status_code;
  if (code != null && code !== 0 && code !== 200) {
    const msg = result.msg ?? result.message ?? result.status_msg ?? 'unknown error';
    if (isAuthLikeError(code, msg)) {
      throw new AuthRequiredError(
        'fxg.jinritemai.com',
        `buyin API auth/permission error ${code} at ${method} ${url}: ${msg}`,
      );
    }
    throw new CommandExecutionError(`buyin API error ${code} at ${method} ${url}: ${msg}`);
  }
  return result;
}
