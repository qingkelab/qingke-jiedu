# link2post 运行镜像：Node 22 + Google Chrome + 中文字体
FROM node:22-slim

# 1) 安装 Google Chrome Stable（与 puppeteer-core v25 匹配）+ 中文字体（渲染中文 PDF/网页）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg fonts-noto-cjk fonts-liberation \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 2) 指向 Chrome 可执行文件；puppeteer-core 依赖此路径
ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# 3) 先装依赖（利用 Docker 层缓存，源码变更不用重装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 4) 拷贝源码
COPY . .

ENV NODE_ENV=production
ENV PORT=4780

EXPOSE 4780

CMD ["node", "server.js"]
