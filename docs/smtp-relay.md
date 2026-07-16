# SMTP HTTP Relay

Cloudflare Workers 不能直接连接 SMTP 端口。这个 Docker 服务把 NodeSeek 的 Email HTTP 通知转换为 SMTP 发信。

## 启动

复制并修改 `docker-compose.smtp-relay.yml` 里的 SMTP 配置：

```yaml
RELAY_TOKEN: "change-me"
SMTP_HOST: "smtp.example.com"
SMTP_PORT: "587"
SMTP_USERNAME: "user@example.com"
SMTP_PASSWORD: "password"
SMTP_FROM: "rss@example.com"
SMTP_STARTTLS: "true"
SMTP_SSL: "false"
```

启动：

```bash
docker compose -f docker-compose.smtp-relay.yml up -d --build
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
```

## NodeSeek 配置

在后台「基础设置」->「通知渠道」选择 `Email`：

- 邮件 API URL：`http://你的服务器IP:8080/send-mail`
- 收件人：你的收件邮箱
- 发件人：你的发件邮箱
- Headers JSON：

```json
{
  "Authorization": "Bearer change-me"
}
```

如果 NodeSeek 部署在 Cloudflare Workers，`邮件 API URL` 必须是公网可访问的 HTTPS/HTTP 地址，不能填 `127.0.0.1` 或内网地址。

## 端口模式

- `SMTP_SSL=true`：通常用于 465 端口。
- `SMTP_STARTTLS=true`：通常用于 587 端口。

二者不要同时开启。
