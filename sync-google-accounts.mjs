#!/usr/bin/env node
/**
 * 按 opencli profileid 同步 Google 账号:遍历 `opencli profile list` 里所有已连接的
 * Browser Bridge profile,对每个 id 跑 `opencli --profile <id> selection accounts
 * -f json` 取它那台 Chrome 登录的 Google 账号,产出 opencli id -> Google 账号 的映射,
 * 写本地 JSON + CSV。
 *
 * 默认全量(同步语义本就是对账:profile 会增减、账号会换,跑一遍自动对上)。
 * 传 -p <profileId> 只同步一个(调试/补单),它只是全量的一个特例。
 * 未连接(Chrome 没开/没装扩展)的 profile 读不到,跳过并在结尾列出。
 *
 * 为什么是 .mjs 而不是 .js:opencli 插件 discovery 只扫 .js 且内容含 cli( 才当命令。
 * 这是独立 runner、不是命令,用 .mjs 避免被误当插件命令加载。
 *
 * 用法:
 *   node sync-google-accounts.mjs                 # 全量
 *   node sync-google-accounts.mjs -p q8j4535x     # 只同步该 profile
 *   node sync-google-accounts.mjs -o ./out        # 指定输出目录(默认当前目录)
 *   OPENCLI_BIN=/path/to/opencli node sync-google-accounts.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OPENCLI = process.env.OPENCLI_BIN || 'opencli';

// ---- args ----
function parseArgs(argv) {
  const out = { profile: '', outDir: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--profile') out.profile = argv[++i] || '';
    else if (a === '-o' || a === '--out-dir') out.outDir = argv[++i] || '.';
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return out;
}
function printHelp() {
  console.log('用法: node sync-google-accounts.mjs [-p <profileId>] [-o <outDir>]');
}

const msg = (e) => (e && e.message) ? e.message : String(e);
// execFileSync 非零退出会抛错,stderr/stdout 挂在 e 上;取最后一行非空当 note
function lastErrLine(e) {
  const s = String((e && (e.stderr || e.stdout)) || '');
  const line = s.split(/\r?\n/).filter((x) => x.trim() && !/UNDICI|trace-warnings/.test(x)).pop();
  return line ? line.trim().slice(0, 200) : '';
}
function opencli(args, timeoutMs = 300000) {
  return execFileSync(OPENCLI, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

// ---- 1) 列出 profile ----
// `opencli profile list` 是人读文本,行形如:
//   已连接:  `  <contextId>[ alias][ default] — connected vX`
//   未连接:  `  <contextId>[ alias] — not connected`(在 "Disconnected saved profiles:" 段)
function listProfiles() {
  let out;
  try {
    out = opencli(['profile', 'list'], 30000);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.error(`找不到 opencli(${OPENCLI})。装好 opencli 或设 OPENCLI_BIN 指向它。`);
    } else {
      console.error(`opencli profile list 失败:${lastErrLine(e) || msg(e)}`);
    }
    process.exit(1);
  }
  const profiles = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+(.*?)—\s*(connected|not connected)/); // — 是长破折号
    if (!m) continue;
    const contextId = m[1];
    const alias = m[2].trim().split(/\s+/).filter((w) => w && w !== 'default')[0] || '';
    profiles.push({ contextId, alias, connected: m[3] === 'connected' });
  }
  return profiles;
}

// ---- 2) 取单个 profile 的 Google 账号 ----
function fetchAccount(contextId) {
  let out;
  try {
    out = opencli(['--profile', contextId, 'selection', 'accounts', '-f', 'json']);
  } catch (e) {
    return { status: 'error', note: lastErrLine(e) || msg(e), accounts: [] };
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    return { status: 'error', note: `JSON 解析失败: ${out.slice(0, 160)}`, accounts: [] };
  }
  const accounts = Array.isArray(data) ? data : (data ? [data] : []);
  if (!accounts.length) return { status: 'no_account', note: '未登录或读不到', accounts: [] };
  return { status: 'ok', note: '', accounts };
}

// ---- CSV ----
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---- main ----
const args = parseArgs(process.argv.slice(2));
mkdirSync(args.outDir, { recursive: true });

let profiles = listProfiles();
if (args.profile) {
  profiles = profiles.filter((p) => p.contextId === args.profile || p.alias === args.profile);
  if (!profiles.length) {
    console.error(`profile "${args.profile}" 不在 opencli profile list 里。`);
    process.exit(1);
  }
}
const connected = profiles.filter((p) => p.connected);
const skipped = profiles.filter((p) => !p.connected);
if (!connected.length) {
  console.error('没有已连接的 Browser Bridge profile。先打开装了 OpenCLI 扩展的 Chrome。');
  process.exit(1);
}

console.log(`同步 ${connected.length} 个已连接 profile…`);
const records = [];
for (const p of connected) {
  const r = fetchAccount(p.contextId);
  const primary = r.accounts.find((a) => a.primary) || r.accounts[0] || null;
  records.push({
    profile: p.contextId,
    alias: p.alias,
    status: r.status,
    email: primary ? primary.email : '',
    name: primary ? (primary.name || '') : '',
    note: r.note,
  });
  const tail = r.status === 'ok' ? `${primary.email}${primary.name ? ` (${primary.name})` : ''}` : (r.note || r.status);
  console.log(`  ${p.contextId}${p.alias ? `/${p.alias}` : ''} -> ${tail}`);
}

const stamp = new Date().toISOString();
const payload = { synced_at: stamp, count: records.length, profiles: records };
const jsonPath = join(args.outDir, 'google-accounts.json');
const csvPath = join(args.outDir, 'google-accounts.csv');
writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

const header = 'profile,alias,status,email,name,note';
const rows = records.map((r) => [r.profile, r.alias, r.status, r.email, r.name, r.note].map(csvCell).join(','));
writeFileSync(csvPath, [header, ...rows].join('\n') + '\n');

const ok = records.filter((r) => r.status === 'ok').length;
console.log(`\n完成:${records.length} 个,成功 ${ok} 个`);
if (skipped.length) console.log(`跳过(未连接):${skipped.map((p) => p.contextId).join(', ')}`);
console.log(`  JSON: ${jsonPath}`);
console.log(`  CSV:  ${csvPath}`);
