/*
 * 被动观测客户端 —— 在你的真实模型调用完成后上报延迟/错误，零额外探测请求。
 *
 * 用法（浏览器侧，监控服务需允许跨域，已在 server.js 开启 CORS）：
 *   <script src="http://<监控服务IP>:8080/passive-client.js"></script>
 *   调用完成后：observeModel('DeepSeek-V4-Flash', { ttftMs, totalMs, status, error });
 *
 * 用法（Node/服务端）：
 *   const { observeModel } = require('./passive-client.js');
 *   await observeModel('DeepSeek-V4-Flash', { ttftMs, totalMs, status });
 *
 * 上报字段：
 *   id        模型标识（需与 config.json 里的 id 一致）
 *   ttftMs    首包延迟（毫秒），没有可省略
 *   totalMs   总延迟（毫秒）
 *   status    HTTP 状态码（如 200 / 429 / 500）
 *   error     错误信息字符串（可选）
 *   rateLimitRemaining / rateLimitLimit  若你的调用拿到了限流头，可一并上报
 */
(function (global) {
  // 监控服务地址：默认同源，跨机请改成 http://<监控服务IP>:8080
  const MONITOR_BASE = global.OBSERVE_BASE || (global.location && global.location.origin) || 'http://localhost:8080';

  async function observeModel(id, metrics) {
    metrics = metrics || {};
    const payload = {
      id: id,
      ttftMs: metrics.ttftMs != null ? metrics.ttftMs : null,
      totalMs: metrics.totalMs != null ? metrics.totalMs : null,
      status: metrics.status != null ? metrics.status : 200,
      error: metrics.error || null,
      rateLimitRemaining: metrics.rateLimitRemaining != null ? metrics.rateLimitRemaining : null,
      rateLimitLimit: metrics.rateLimitLimit != null ? metrics.rateLimitLimit : null,
    };
    try {
      await fetch(MONITOR_BASE + '/api/observe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return true;
    } catch (e) {
      // 上报失败不影响主流程
      return false;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { observeModel, MONITOR_BASE };
  } else {
    global.observeModel = observeModel;
    global.OBSERVE_BASE = MONITOR_BASE;
  }
})(typeof window !== 'undefined' ? window : globalThis);
