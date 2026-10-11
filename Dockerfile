# 自定义模型繁忙度监控 —— 发布用 Dockerfile
# 构建:  docker build -t model-monitor:latest .
# 运行:  docker run -d -p 8080:8080 -e PORT=8080 -e ACCESS_TOKEN=<你的访问令牌> model-monitor:latest
#   - 可选: -v ./data:/app/data  挂载持久化历史 CSV
#   - 可选: -v ./config.json:/app/config.json  挂载自定义模型配置(切勿把含 Key 的 config.json 打进镜像)
FROM node:18-alpine

# 非 root 运行，缩小容器逃逸攻击面（node:18-alpine 内置 node 用户 uid=1000）
WORKDIR /app

COPY app/server.js ./
COPY app/public ./public

# /app/data 需在容器内可由 node 用户读写（进程运行期创建历史 CSV）
RUN chown -R node:node /app && chmod u+w /app
VOLUME ["/app/data"]

EXPOSE 8080

ENV HOST=0.0.0.0
ENV PORT=8080

USER node

CMD ["node", "server.js"]
