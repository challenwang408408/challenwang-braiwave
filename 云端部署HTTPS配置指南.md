# 云端部署HTTPS配置指南

## 问题说明

PC端浏览器对非localhost的HTTP访问麦克风有严格限制，必须使用HTTPS。本地部署时使用`localhost`可以正常工作，但部署到云端后必须配置HTTPS。

## 解决方案

### 方案一：使用Nginx反向代理 + Let's Encrypt（推荐）

这是最常用和推荐的方案，适合生产环境。

#### 1. 安装Nginx和Certbot

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx

# CentOS/RHEL
sudo yum install nginx certbot python3-certbot-nginx
```

#### 2. 配置Nginx反向代理

创建Nginx配置文件 `/etc/nginx/sites-available/brainwave`：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为您的域名

    # 重定向HTTP到HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;  # 替换为您的域名

    # SSL证书路径（Certbot会自动配置）
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL配置（推荐设置）
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # WebSocket支持
    location /api/v1/ws {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # 其他API和静态文件
    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### 3. 启用配置

```bash
# 创建符号链接
sudo ln -s /etc/nginx/sites-available/brainwave /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重启Nginx
sudo systemctl restart nginx
```

#### 4. 获取SSL证书

```bash
# 使用Certbot自动获取和配置SSL证书
sudo certbot --nginx -d your-domain.com

# 按照提示操作，Certbot会自动：
# 1. 获取Let's Encrypt证书
# 2. 配置Nginx使用HTTPS
# 3. 设置自动续期
```

#### 5. 确保Brainwave服务运行在3005端口

确保您的Brainwave服务运行在`127.0.0.1:3005`（只监听本地，由Nginx代理）。

修改`start.sh`或直接运行：
```bash
uvicorn realtime_server:app --host 127.0.0.1 --port 3005
```

#### 6. 设置防火墙

```bash
# 允许HTTP和HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 不需要开放3005端口（只本地访问）
```

### 方案二：Uvicorn直接支持SSL（需要证书文件）

如果您已经有SSL证书文件，可以直接让Uvicorn使用HTTPS。

#### 1. 修改启动命令

```bash
uvicorn realtime_server:app \
    --host 0.0.0.0 \
    --port 3005 \
    --ssl-keyfile /path/to/private.key \
    --ssl-certfile /path/to/certificate.crt
```

#### 2. 获取自签名证书（仅用于测试）

```bash
# 生成自签名证书（仅用于开发测试）
openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout key.pem -out cert.pem \
    -days 365 -subj "/CN=your-domain.com"
```

**注意**：自签名证书会在浏览器中显示警告，用户需要手动接受。

### 方案三：使用Cloudflare（最简单）

如果您使用Cloudflare作为CDN：

1. 在Cloudflare中配置您的域名
2. 启用"SSL/TLS加密模式"为"完全"或"完全（严格）"
3. Cloudflare会自动提供HTTPS，无需配置服务器端证书

## 验证HTTPS配置

### 1. 检查SSL证书

访问 `https://your-domain.com`，浏览器地址栏应该显示锁图标。

### 2. 测试麦克风访问

1. 打开浏览器开发者工具（F12）
2. 访问应用页面
3. 点击"开始"按钮
4. 检查控制台是否有HTTPS相关错误
5. 如果配置正确，应该能正常调起麦克风

### 3. 检查WebSocket连接

在浏览器控制台检查WebSocket连接：
- HTTP应该使用 `ws://`
- HTTPS应该使用 `wss://`

## 常见问题

### 1. 证书续期

Let's Encrypt证书每90天需要续期。Certbot会自动设置续期任务，但可以手动测试：

```bash
sudo certbot renew --dry-run
```

### 2. Nginx配置错误

如果Nginx配置有误，检查日志：
```bash
sudo tail -f /var/log/nginx/error.log
```

### 3. WebSocket连接失败

确保Nginx配置中包含了WebSocket的`upgrade`头设置（见方案一中的配置）。

### 4. 端口冲突

确保3005端口没有被其他程序占用：
```bash
sudo netstat -tlnp | grep 3005
```

## 推荐配置

对于生产环境，推荐使用：
- **方案一（Nginx + Let's Encrypt）**：最稳定、最安全、自动续期
- **方案三（Cloudflare）**：最简单，适合已有Cloudflare账户的用户

## 更新日期
2026-02-06
