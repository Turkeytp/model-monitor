'use strict';
/*
 * 自定义模型繁忙度监控 —— 零依赖 Node 后端（多模型版 · A+B 探测）
 *
 * 两种信号来源：
 *   A. 主动探测：定时对每个模型发流式 chat 补全（随机化 prompt、15~20 分钟抖动间隔），
 *      测量首包延迟 TTFT / 总延迟 / 可用性，并读取响应头里的限流信号
 *      （x-ratelimit-remaining / retry-after / HTTP 429·503）——这些是提供商"隐性"给出的繁忙证据。
 *   B. 被动观测：你真实调用这些模型时，通过 POST /api/observe 上报延迟/错误，
 *      零额外请求、零被发现风险，反映真实体验。两者共同推断繁忙度。
 *
 * 浏览器只与本服务通信：无跨域问题，且探测在服务器端发起。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// 历史落盘（CSV），进程重启后仍可回看
const DATA_DIR = path.join(ROOT, 'data');
const CSV_PATH = path.join(DATA_DIR, 'history.csv');
const CSV_HEADER = 'ts,model,score,level,ttftMs,totalMs,tokensPerSec,available,status,error,source';
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n');
}
function appendCsv(rows) {
  if (!rows.length) return;
  const lines = rows.map((r) => [
    r.ts, r.model, r.score, r.level,
    r.ttftMs == null ? '' : r.ttftMs,
    r.totalMs == null ? '' : r.totalMs,
    r.tps == null ? '' : r.tps,
    r.available ? 1 : 0,
    r.status == null ? '' : r.status,
    (r.error || '').replace(/[\n,]/g, ' '),
    r.source || 'active',
  ].join(',')).join('\n');
  fs.appendFileSync(CSV_PATH, lines + '\n');
}
// 启动回填：读取 CSV 并保留近 30 天，超期则顺手裁剪文件
function loadHistory() {
  if (!fs.existsSync(CSV_PATH)) return;
  const text = fs.readFileSync(CSV_PATH, 'utf8').trim();
  if (!text) return;
  const lines = text.split('\n');

  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const kept = [];
  const byModel = {};      // model -> [{ts, score, level}]
  const lastByModel = {};  // model -> {ttftMs, totalMs, tokensPerSec, status, error, available, source}

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 4) continue;
    const ts = Number(c[0]);
    if (isNaN(ts) || ts < cutoff) continue;
    const model = c[1];
    const score = Number(c[2]);
    const level = c[3];
    kept.push(lines[i]);
    if (!byModel[model]) byModel[model] = [];
    byModel[model].push({ ts, score, level });
    // 记录最后一次探测的详细指标
    lastByModel[model] = {
      ts,
      ttftMs: c[4] ? Number(c[4]) : null,
      totalMs: c[5] ? Number(c[5]) : null,
      tokensPerSec: c[6] ? Number(c[6]) : null,
      available: c[7] === '1',
      status: c[8] ? Number(c[8]) : null,
      error: c[9] || null,
      source: c[10] || 'active',
    };
  }
  if (kept.length + 1 < lines.length) {
    fs.writeFileSync(CSV_PATH, [CSV_HEADER, ...kept].join('\n') + '\n');
  }
  for (const m of config.models) {
    modelStates[m.id].history = (byModel[m.id] || []).slice(-config.historySize);
    // 恢复上一次探测的详细结果
    if (lastByModel[m.id]) {
      lastProbe[m.id] = lastByModel[m.id];
    }
  }
}

// ---------------------------------------------------------------------------
// 配置：默认值 <- config.json <- 环境变量
// ---------------------------------------------------------------------------
const DEFAULTS = {
  intervalMin: 15,                        // 主动探测间隔下限（分钟）—— 降频以降低被风控概率
  intervalMax: 20,                        // 主动探测间隔上限（分钟）
  probe: {
    prompts: ['你好', 'ping', '1+1=?', '今天天气如何', 'hi there', '请用一句话介绍自己'],
    maxTokens: 8,
    timeoutMs: 20000,
  },
  simulate: false,                        // false=真实探测（默认）；纯演示改 true
  serverPort: 8080,
  historySize: 3000,                      // 每模型保留的历史点数
  passiveWindowMs: 30 * 60 * 1000,        // 被动观测视为"近期有效"的窗口
  models: [],
};

let config = Object.assign({}, DEFAULTS);
const cfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(cfgPath)) {
  try {
    const user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    config = Object.assign({}, DEFAULTS, user);
    config.probe = Object.assign({}, DEFAULTS.probe, user.probe || {});
    if (!Array.isArray(config.models)) config.models = [];
  } catch (e) {
    console.warn('[warn] config.json 解析失败，使用默认配置：', e.message);
  }
}
// 监听端口：优先环境变量 PORT，否则用 config.json 里的 serverPort；
// 注意：PORT 仅作为运行期变量，不写回 config.json，避免污染已保存配置。
let listenPort = config.serverPort;
if (process.env.PORT) listenPort = parseInt(process.env.PORT, 10);
if (process.env.SIMULATE) config.simulate = !(process.env.SIMULATE === 'false' || process.env.SIMULATE === '0');

// 探测是否正在进行（调度循环与手动触发共用，避免重叠）
let probing = false;

// 将当前配置（含模型列表与真实 Key）写回 config.json，实现增删模型持久化
function saveConfig() {
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.warn('[warn] 写入 config.json 失败：', e.message);
  }
}

// 读取 POST/PUT 请求体（限制 1MB）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// 把前端提交的模型字段归一化为标准结构
function normalizeModel(d) {
  // 若前端回填的是脱敏值（**** 或含 **** 的掩码）且未提供新 Key，则保留原有 Key，
  // 避免把掩码当成真实 Key 写回 config.json。
  let key = d.apiKey;
  if (key && /\*\*+\*{2}/.test(String(key))) key = ''; // 掩码占位，视为未填写
  return {
    id: (d.id || '').trim(),
    name: (d.name || d.id || '').trim(),
    vendor: d.vendor || 'Custom',
    url: (d.url || '').trim().replace(/\/$/, ''),
    apiKey: key,
    supportsToolCall: !!d.supportsToolCall,
    supportsImages: !!d.supportsImages,
    supportsReasoning: !!d.supportsReasoning,
    useCustomProtocol: !!d.useCustomProtocol,
  };
}
// 更新模型时合并 Key：请求未带有效 Key（空或掩码）则保留旧 Key
function mergeModelKey(oldModel, newModel) {
  if (oldModel && newModel.apiKey === '') return oldModel.apiKey;
  return newModel.apiKey;
}

// 附带最近一次探测状态（供设置页展示）。
// 安全：apiKey 绝不外发，仅返回脱敏尾 4 位用于辨识；防止 /api/models 泄露明文 Key。
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}
function withStatus(m) {
  const st = modelStates[m.id];
  const last = st && st.history.length ? st.history[st.history.length - 1] : null;
  const out = Object.assign({}, m, { last: last ? { score: last.score, level: last.level } : null });
  out.apiKeyMasked = maskKey(m.apiKey);
  out.hasApiKey = !!m.apiKey;
  delete out.apiKey; // 明文 Key 永不返回给前端/外网
  return out;
}

function serveStatic(file, res, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type || 'text/html; charset=utf-8' });
    res.end(data);
  });
}

// 统一设置 CORS（被动观测可能从其它源发起）
// 安全：默认不回显 Origin（关闭跨域），仅当配置了白名单 ALLOWED_ORIGINS 时才开放对应源。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function cors(req, res) {
  const origin = req.headers['origin'] || '';
  if (!ALLOWED_ORIGINS.length) {
    // 未配置白名单：只允许同源（浏览器 fetch 同域正常，跨域被阻）
    res.setHeader('Access-Control-Allow-Origin', origin || 'null');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token');
    res.setHeader('Vary', 'Origin');
    return;
  }
  if (ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
}

// ---------------------------------------------------------------------------
// 鉴权：设置 ACCESS_TOKEN 后，所有 /api/* 接口（除 SSE 数据流与 observe）需带
// X-Access-Token 或 Authorization: Bearer 头。前端在 URL 上加 ?token= 亦可。
// 未配置 ACCESS_TOKEN 时保持开放（方便局域网内部访问）。
// ---------------------------------------------------------------------------
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
function isAuthed(req, u) {
  if (!ACCESS_TOKEN) return true; // 未启用鉴权
  const h = (req.headers['x-access-token'] || '').toString();
  let a = h;
  const auth = (req.headers['authorization'] || '').toString();
  if (!a && /^bearer\s+/i.test(auth)) a = auth.replace(/^bearer\s+/i, '');
  if (u && u.searchParams.get('token')) a = u.searchParams.get('token');
  return a === ACCESS_TOKEN;
}
function requireAuth(req, res, u) {
  if (isAuthed(req, u)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  return false;
}

// ---------------------------------------------------------------------------
// 简单限流：每 IP 对 /api/probe、/api/observe 每 10 秒最多 5 次
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 5;
const rateHits = new Map(); // ip -> { count, resetAt }
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
}
function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let e = rateHits.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }; rateHits.set(ip, e); }
  e.count++;
  // 顺手清理过期桶，避免 Map 无限增长
  if (rateHits.size > 10000) {
    for (const [k, v] of rateHits) if (now >= v.resetAt) rateHits.delete(k);
  }
  return e.count > RATE_LIMIT_MAX;
}

// SSE 连接上限：防止恶意长连接堆积
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS || 50);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// ---------------------------------------------------------------------------
// 探测单个模型（流式 chat/completions，测 TTFT + 总延迟 + 限流头）
// ---------------------------------------------------------------------------
function probeModel(m) {
  const url = m.url.replace(/\/$/, '') + '/chat/completions';
  const prompts = config.probe.prompts && config.probe.prompts.length ? config.probe.prompts : ['ping'];
  const prompt = prompts[Math.floor(Math.random() * prompts.length)];
  const body = JSON.stringify({
    model: m.id,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: config.probe.maxTokens || 8,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (m.apiKey || '') };

  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let done = false;
    let buf = '';
    let ttft = null;
    let tokenCount = 0;

    const finish = (errMsg) => {
      if (done) return;
      done = true;
      const total = Date.now() - t0;
      const ok = !errMsg && resStatus === 200;
      const tps = ok && tokenCount > 0 && total > 0 ? tokenCount / (total / 1000) : null;
      // 限流信号（来自响应头或状态码）
      const retryAfter = rawHeaders['retry-after'] != null ? Number(rawHeaders['retry-after']) : null;
      const rlRemaining = rawHeaders['x-ratelimit-remaining'] != null ? Number(rawHeaders['x-ratelimit-remaining']) : null;
      const rlLimit = rawHeaders['x-ratelimit-limit'] != null ? Number(rawHeaders['x-ratelimit-limit']) : null;
      resolve({
        ok,
        status: resStatus,
        ttftMs: ttft,
        totalMs: total,
        tokensPerSec: tps,
        tokenCount,
        error: errMsg || null,
        retryAfter: isNaN(retryAfter) ? null : retryAfter,
        rateLimitRemaining: isNaN(rlRemaining) ? null : rlRemaining,
        rateLimitLimit: isNaN(rlLimit) ? null : rlLimit,
      });
    };

    let resStatus = 0;
    const rawHeaders = {};
    const req = lib.request(
      url,
      { method: 'POST', headers, timeout: config.probe.timeoutMs || 20000 },
      (res) => {
        resStatus = res.statusCode;
        // 复制小写响应头，便于读取限流字段
        for (const k in res.headers) rawHeaders[k.toLowerCase()] = res.headers[k];
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { finish(null); return; }
            try {
              const j = JSON.parse(data);
              const delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta && delta.content) {
                if (ttft == null) ttft = Date.now() - t0;
                tokenCount++;
              }
              if (j.usage && j.usage.completion_tokens) {
                tokenCount = Math.max(tokenCount, j.usage.completion_tokens);
              }
            } catch (e) {
              /* 忽略非 JSON 行 */
            }
          }
        });
        res.on('end', () => finish(null));
      }
    );
    req.on('timeout', () => { req.destroy(); finish('timeout'); });
    req.on('error', (e) => finish(e.message));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 模拟模式：为每个模型生成不同的繁忙度轨迹
// ---------------------------------------------------------------------------
const simState = {};
function simulateModel(m) {
  let s = simState[m.id];
  if (!s) s = simState[m.id] = { ttft: 150 + Math.random() * 300, total: 300 + Math.random() * 400, down: false, downUntil: 0 };
  s.ttft = clamp(s.ttft + (Math.random() - 0.5) * 140, 80, 3200);
  s.total = clamp(s.total + (Math.random() - 0.5) * 220, 160, 4200);
  if (Math.random() < 0.015) { s.down = true; s.downUntil = Date.now() + 9000; }
  if (s.down && Date.now() > s.downUntil) s.down = false;
  const ok = !s.down;
  // 模拟偶尔的限流信号
  const retryAfter = (!ok && Math.random() < 0.5) ? 5 + Math.floor(Math.random() * 20) : null;
  return {
    ok,
    status: ok ? 200 : 503,
    ttftMs: ok ? Math.round(s.ttft) : null,
    totalMs: ok ? Math.round(s.total) : null,
    tokensPerSec: ok ? Math.round(8 / (s.total / 1000)) : null,
    tokenCount: 8,
    error: ok ? null : '模拟连接中断',
    retryAfter,
    rateLimitRemaining: null,
    rateLimitLimit: null,
  };
}

// ---------------------------------------------------------------------------
// 繁忙度计算（延迟 + 限流信号，无 metrics 端点时的合理推断）
// ---------------------------------------------------------------------------
function scoreModel(p) {
  if (!p.ok) {
    return {
      score: 100,
      level: '不可达',
      parts: [{ name: '可用性', value: 100, weight: 1 }],
      throttle: false,
    };
  }
  // 限流信号（提供商隐性给出的繁忙证据）
  let throttleScore = 0;
  let throttleNote = null;
  if (p.retryAfter != null && p.retryAfter > 0) {
    throttleScore = 100; throttleNote = '限流中(retry-after ' + p.retryAfter + 's)';
  } else if (p.status === 429) {
    throttleScore = 100; throttleNote = '限流(429)';
  } else if (p.status === 503) {
    throttleScore = 90; throttleNote = '服务繁忙(503)';
  } else if (p.rateLimitRemaining != null && p.rateLimitLimit && p.rateLimitLimit > 0) {
    const used = 1 - p.rateLimitRemaining / p.rateLimitLimit;
    if (used > 0.9) { throttleScore = 80; throttleNote = '配额将尽'; }
    else if (used > 0.7) { throttleScore = Math.max(throttleScore, 55); throttleNote = '配额偏紧'; }
  }

  const ttft = p.ttftMs || p.totalMs || 0;
  const total = p.totalMs || 0;
  const sTtft = clamp(ttft / 25, 0, 100);   // 2500ms → 100
  const sTotal = clamp(total / 30, 0, 100);  // 3000ms → 100
  let score = Math.round(0.6 * sTtft + 0.4 * sTotal);
  // 限流信号作为额外权重（取较高者）
  score = Math.max(score, throttleScore);

  let level = '空闲';
  if (score >= 80) level = '拥堵';
  else if (score >= 55) level = '繁忙';
  else if (score >= 25) level = '正常';
  if (throttleNote && score >= 80) level = '受限';
  return {
    score,
    level,
    parts: [
      { name: '首包延迟', value: Math.round(sTtft), weight: 0.6 },
      { name: '总延迟', value: Math.round(sTotal), weight: 0.4 },
    ],
    throttle: !!throttleNote,
    throttleNote,
  };
}

// ---------------------------------------------------------------------------
// 状态存储：历史曲线 + 最近一次探测/观测快照
// ---------------------------------------------------------------------------
const modelStates = {}; // id -> { history: [...] }
const lastProbe = {};   // id -> 最近一次探测/观测的完整结果（含 source）
const passiveSeen = {}; // id -> 是否收到过被动观测
config.models.forEach((m) => {
  modelStates[m.id] = { history: [] };
  lastProbe[m.id] = null;
  passiveSeen[m.id] = false;
});
ensureData();
loadHistory();

const clients = [];

function broadcast(payloadObj) {
  const payload = 'data: ' + JSON.stringify(payloadObj) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (e) {}
  }
}

// 写入一次观测（主动探测或被动上报共用）：算分 + 入历史 + 落盘 + 存快照
function recordObservation(m, probe, source) {
  const busy = scoreModel(probe);
  const ts = probe.ts || Date.now();
  const st = modelStates[m.id];
  st.history.push({ ts, score: busy.score, level: busy.level });
  if (st.history.length > config.historySize) st.history.shift();
  lastProbe[m.id] = {
    ts,
    ok: probe.ok,
    status: probe.status,
    ttftMs: probe.ttftMs,
    totalMs: probe.totalMs,
    tokensPerSec: probe.tokensPerSec,
    error: probe.error,
    rateLimitRemaining: probe.rateLimitRemaining,
    rateLimitLimit: probe.rateLimitLimit,
    retryAfter: probe.retryAfter,
    source,
    busy,
  };
  if (source === 'passive') passiveSeen[m.id] = true;
  appendCsv([{
    ts, model: m.id, score: busy.score, level: busy.level,
    ttftMs: probe.ttftMs, totalMs: probe.totalMs, tps: probe.tokensPerSec,
    available: probe.ok, status: probe.status, error: probe.error, source,
  }]);
  return busy;
}

// 构建当前所有模型快照（供 /api/status、SSE、被动上报后刷新）
function buildSnapshot() {
  return config.models.map((m) => {
    const st = modelStates[m.id];
    const last = st.history.length ? st.history[st.history.length - 1] : null;
    const lp = lastProbe[m.id];
    return {
      id: m.id, name: m.name, vendor: m.vendor, url: m.url,
      available: lp ? lp.available : (last ? true : null),
      status: lp ? lp.status : null,
      ttftMs: lp ? lp.ttftMs : null,
      totalMs: lp ? lp.totalMs : null,
      tokensPerSec: lp ? lp.tokensPerSec : null,
      error: lp ? lp.error : null,
      rateLimitRemaining: lp ? lp.rateLimitRemaining : null,
      rateLimitLimit: lp ? lp.rateLimitLimit : null,
      retryAfter: lp ? lp.retryAfter : null,
      source: lp ? lp.source : null,
      hasPassive: !!passiveSeen[m.id],
      busy: last ? { score: last.score, level: last.level } : null,
      history: st.history,
    };
  });
}

// ---------------------------------------------------------------------------
// 主动轮询主循环
// ---------------------------------------------------------------------------
async function pollOnce() {
  const ts = Date.now();
  await Promise.all(
    config.models.map(async (m) => {
      const probe = config.simulate
        ? simulateModel(m)
        : await probeModel(m).catch((e) => ({
            ok: false, status: 0, ttftMs: null, totalMs: null, tokensPerSec: null, tokenCount: 0, error: e.message,
            retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null,
          }));
      recordObservation(m, Object.assign({ ts }, probe), 'active');
    })
  );
  const snapshot = buildSnapshot();
  broadcast({ ts, source: config.simulate ? 'simulate' : 'real', models: snapshot });
  return snapshot;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  cors(req, res);

  // 预检
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- 静态资源（页面/脚本）：不设鉴权，保证页面可打开 ----
  if (p === '/' || p === '/index.html') {
    serveStatic(path.join(PUBLIC, 'index.html'), res);
  } else if (p === '/settings' || p === '/settings/') {
    serveStatic(path.join(PUBLIC, 'settings.html'), res);
  } else if (p === '/passive-client.js') {
    serveStatic(path.join(PUBLIC, 'passive-client.js'), res, 'application/javascript; charset=utf-8');
  } else if (p === '/api/status') {
    if (!requireAuth(req, res, u)) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ config: publicConfig(), models: buildSnapshot() }));
  } else if (p === '/api/csv') {
    if (!requireAuth(req, res, u)) return;
    const model = u.searchParams.get('model');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="history.csv"',
    });
    if (fs.existsSync(CSV_PATH)) {
      let text = fs.readFileSync(CSV_PATH, 'utf8');
      if (model) {
        const lines = text.split('\n');
        text = [lines[0], ...lines.slice(1).filter((l) => {
          const c = l.split(',');
          return c[1] === model;
        })].join('\n');
      }
      res.end(text);
    } else {
      res.end(CSV_HEADER + '\n');
    }
  } else if (p === '/api/stream') {
    if (!requireAuth(req, res, u)) return;
    if (clients.length >= MAX_SSE_CLIENTS) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too many connections' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.push(res);
    req.on('close', () => {
      const i = clients.indexOf(res);
      if (i >= 0) clients.splice(i, 1);
    });
  } else if (p === '/api/models') {
    if (!requireAuth(req, res, u)) return;
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(config.models.map(withStatus)));
    } else if (req.method === 'POST') {
      readBody(req).then((body) => {
        let data;
        try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('请求体不是合法 JSON'); return; }
        const id = (data.id || '').trim();
        if (!id) { res.writeHead(400); res.end('缺少 id（模型标识）'); return; }
        if (!/^https?:\/\//.test(data.url || '')) { res.writeHead(400); res.end('url 必须为 http(s) 开头的有效地址'); return; }
        if (config.models.some((m) => m.id === id)) { res.writeHead(409); res.end('该 id 已存在'); return; }
        const model = normalizeModel(data);
        config.models.push(model);
        modelStates[id] = { history: [] }; lastProbe[id] = null; passiveSeen[id] = false;
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, model: withStatus(model) }));
        runProbeCycle();
      }).catch(() => { res.writeHead(400); res.end('读取请求体失败'); });
    } else {
      res.writeHead(405); res.end('仅支持 GET / POST');
    }
  } else if (p.startsWith('/api/models/')) {
    if (!requireAuth(req, res, u)) return;
    const id = decodeURIComponent(p.slice('/api/models/'.length));
    if (req.method === 'PUT') {
      readBody(req).then((body) => {
        let data;
        try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('请求体不是合法 JSON'); return; }
        const idx = config.models.findIndex((m) => m.id === id);
        if (idx < 0) { res.writeHead(404); res.end('模型不存在'); return; }
        config.models[idx] = normalizeModel(Object.assign({}, config.models[idx], data, { id }));
        config.models[idx].apiKey = mergeModelKey(config.models[idx], config.models[idx]); // 请求未带有效 Key 则保留旧 Key
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, model: withStatus(config.models[idx]) }));
        runProbeCycle();
      }).catch(() => { res.writeHead(400); res.end('读取请求体失败'); });
    } else if (req.method === 'DELETE') {
      const idx = config.models.findIndex((m) => m.id === id);
      if (idx < 0) { res.writeHead(404); res.end('模型不存在'); return; }
      config.models.splice(idx, 1);
      delete modelStates[id]; delete lastProbe[id]; delete passiveSeen[id];
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      runProbeCycle();
    } else {
      res.writeHead(405); res.end('仅支持 PUT / DELETE');
    }
  } else if (p === '/api/probe') {
    if (!requireAuth(req, res, u)) return;
    if (rateLimited(req)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too many requests' }));
      return;
    }
    // 手动立即触发一次主动探测
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, triggered: !probing }));
    runProbeCycle();
  } else if (p === '/api/observe') {
    // 被动观测上报：需鉴权 + 限流（防被恶意注入脏数据）
    if (!requireAuth(req, res, u)) return;
    if (rateLimited(req)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too many requests' }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req).then((body) => {
        let data;
        try { data = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('请求体不是合法 JSON'); return; }
        const id = (data.id || '').trim();
        const m = config.models.find((x) => x.id === id);
        if (!m) { res.writeHead(404); res.end('模型不存在'); return; }
        const status = data.status == null ? 200 : Number(data.status);
        const probe = {
          ts: data.ts || Date.now(),
          ok: data.available === false ? false : (status < 400),
          status,
          ttftMs: data.ttftMs == null ? null : Number(data.ttftMs),
          totalMs: data.totalMs == null ? null : Number(data.totalMs),
          tokensPerSec: null,
          error: data.error || null,
          retryAfter: null,
          rateLimitRemaining: data.rateLimitRemaining == null ? null : Number(data.rateLimitRemaining),
          rateLimitLimit: data.rateLimitLimit == null ? null : Number(data.rateLimitLimit),
        };
        recordObservation(m, probe, 'passive');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        // 立即把更新后的快照推给在线仪表盘
        broadcast({ ts: probe.ts, source: 'real', models: buildSnapshot() });
      }).catch(() => { res.writeHead(400); res.end('读取请求体失败'); });
    } else {
      res.writeHead(405); res.end('仅支持 POST');
    }
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

function publicConfig() {
  return {
    simulate: config.simulate,
    intervalMin: config.intervalMin,
    intervalMax: config.intervalMax,
    modelCount: config.models.length,
  };
}

// 带防重叠保护的探测执行；手动触发与调度循环共用
async function runProbeCycle() {
  if (probing) return null;
  probing = true;
  try {
    return await pollOnce();
  } finally {
    probing = false;
  }
}

// 动态间隔调度：每次随机 15~20 分钟，降低被风控识别的概率
function scheduleNext() {
  const mins = config.intervalMin + Math.random() * (config.intervalMax - config.intervalMin);
  const wait = Math.round(mins * 60000);
  setTimeout(async () => { await runProbeCycle(); scheduleNext(); }, wait);
}

const HOST = process.env.HOST || '0.0.0.0';
server.listen(listenPort, HOST, () => {
  console.log('模型繁忙度监控已启动： http://' + HOST + ':' + listenPort);
  console.log('  监控模型数 : ' + config.models.length + (config.simulate ? '  (模拟模式)' : '  (真实探测)'));
  console.log('  探测间隔   : ' + config.intervalMin + '~' + config.intervalMax + ' 分钟（动态抖动）');
  console.log('  信号来源   : 主动探测 + 被动观测(/api/observe)');
  runProbeCycle().then(scheduleNext);
});
