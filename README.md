# model-monitor

自定义模型繁忙度监控 —— 零依赖 Node 后端 + 纯 HTML/JS 前端仪表盘。

## 预览

仪表盘实时显示各模型的首包延迟 / 总延迟 / 繁忙度评分，并绘制 7 天繁忙度趋势曲线（见 `docs/screenshot.png`）：

![仪表盘截图](docs/screenshot.png)

## 功能

- **主动探测**：定时（15~20 分钟随机抖动）对每个模型发流式 chat 补全，测量首包延迟（TTFT）/ 总延迟 / 可用性，并读取响应头限流信号（`x-ratelimit-remaining`、`retry-after`、HTTP 429/503）。
- **被动观测**：真实调用后通过 `POST /api/observe` 上报延迟/错误，零额外请求。两者共同推断繁忙度。
- **多模型管理**：仪表盘设置页增删改模型，改动即时写 `config.json` 并立即探测验证。
- **历史回看**：CSV 落盘，进程重启后保留近 30 天。

## 运行

```bash
docker build -t model-monitor:latest .
docker run -d -p 8080:8080 model-monitor:latest
# 启用访问鉴权:
#   -e ACCESS_TOKEN=你的令牌
# 持久化历史:
#   -v $(pwd)/data:/app/data
```

浏览器打开 `http://<host>:8080/`。

## 安全

- 明文 API Key **永不返回**给前端/外网（`/api/models` 仅返回尾 4 位掩码）。
- `config.json` / `data/` 为运行期数据，由 `.dockerignore` + `.gitignore` 排除，**绝不进镜像、绝不进仓库**。
