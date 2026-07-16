import { DatabaseService, KeywordSub, NotificationChannel, NotificationChannelType, Post } from './database';
import { TelegramService } from './telegram';

export interface NotificationSendResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface NotificationChannelSendResult extends NotificationSendResult {
  channel_id?: number;
  channel_type: NotificationChannelType;
  channel_name: string;
}

export interface NotificationPostResult {
  success: boolean;
  total: number;
  successCount: number;
  failureCount: number;
  results: NotificationChannelSendResult[];
}

interface NotificationProvider {
  send(post: Post, matchedSub: KeywordSub): Promise<NotificationSendResult>;
  test(): Promise<NotificationSendResult>;
}

interface TelegramChannelConfig {
  bot_token?: string;
  chat_id?: string;
}

interface HttpChannelConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
  to?: string;
  from?: string;
  subject?: string;
}

const DEFAULT_TIMEOUT_MS = 10000;

export class NotificationService {
  constructor(private dbService: DatabaseService) {}

  async hasEnabledChannels(): Promise<boolean> {
    const channels = await this.getDispatchChannels();
    return channels.length > 0;
  }

  async sendPost(post: Post, matchedSub: KeywordSub): Promise<NotificationPostResult> {
    const channels = await this.getDispatchChannels();
    const results: NotificationChannelSendResult[] = [];

    if (channels.length === 0) {
      return {
        success: false,
        total: 0,
        successCount: 0,
        failureCount: 0,
        results: []
      };
    }

    for (const channel of channels) {
      const result = await this.sendToChannel(channel, post, matchedSub);
      results.push(result);

      if (channel.id) {
        await this.dbService.createNotificationDelivery({
          post_id: post.post_id,
          channel_id: channel.id,
          status: result.success ? 'success' : 'failed',
          error: result.success ? null : (result.error || result.message)
        });
      }
    }

    const successCount = results.filter(result => result.success).length;
    const failureCount = results.length - successCount;

    return {
      success: successCount > 0,
      total: results.length,
      successCount,
      failureCount,
      results
    };
  }

  private async getDispatchChannels(): Promise<NotificationChannel[]> {
    await this.syncLegacyTelegramChannel();
    return this.dbService.getEnabledNotificationChannels();
  }

  private async syncLegacyTelegramChannel(): Promise<void> {
    const [baseConfig, telegramChannel] = await Promise.all([
      this.dbService.getBaseConfig(),
      this.dbService.getNotificationChannelByType('telegram')
    ]);

    if (!baseConfig?.bot_token || !baseConfig.chat_id) {
      return;
    }

    if (!telegramChannel) {
      await this.dbService.createNotificationChannel({
        type: 'telegram',
        name: 'Telegram',
        enabled: 1,
        config_json: JSON.stringify({
          bot_token: baseConfig.bot_token,
          chat_id: baseConfig.chat_id
        })
      });
      return;
    }

    if (telegramChannel.enabled !== 1) {
      return;
    }

    const channelConfig = parseConfig(telegramChannel.config_json);
    if (channelConfig.bot_token && channelConfig.chat_id) {
      return;
    }

    await this.dbService.updateNotificationChannel(telegramChannel.id as number, {
      config_json: JSON.stringify({
        ...channelConfig,
        bot_token: channelConfig.bot_token || baseConfig.bot_token,
        chat_id: channelConfig.chat_id || baseConfig.chat_id
      })
    });
  }

  async testChannel(channel: NotificationChannel): Promise<NotificationChannelSendResult> {
    try {
      const provider = this.createProvider(channel);
      const result = await provider.test();
      return {
        ...result,
        channel_id: channel.id,
        channel_type: channel.type,
        channel_name: channel.name
      };
    } catch (error) {
      return {
        success: false,
        message: '通知渠道测试失败',
        error: String(error),
        channel_id: channel.id,
        channel_type: channel.type,
        channel_name: channel.name
      };
    }
  }

  private async sendToChannel(channel: NotificationChannel, post: Post, matchedSub: KeywordSub): Promise<NotificationChannelSendResult> {
    try {
      const provider = this.createProvider(channel);
      const result = await provider.send(post, matchedSub);
      return {
        ...result,
        channel_id: channel.id,
        channel_type: channel.type,
        channel_name: channel.name
      };
    } catch (error) {
      return {
        success: false,
        message: '通知发送失败',
        error: String(error),
        channel_id: channel.id,
        channel_type: channel.type,
        channel_name: channel.name
      };
    }
  }

  private createProvider(channel: NotificationChannel): NotificationProvider {
    const config = parseConfig(channel.config_json);

    switch (channel.type) {
      case 'telegram':
        return new TelegramNotificationProvider(this.dbService, config as TelegramChannelConfig);
      case 'email':
        return new EmailNotificationProvider(config as HttpChannelConfig);
      case 'webhook':
        return new WebhookNotificationProvider(config as HttpChannelConfig);
      default:
        throw new Error(`不支持的通知渠道类型: ${channel.type}`);
    }
  }
}

class TelegramNotificationProvider implements NotificationProvider {
  constructor(
    private dbService: DatabaseService,
    private config: TelegramChannelConfig
  ) {}

  async send(post: Post, matchedSub: KeywordSub): Promise<NotificationSendResult> {
    const baseConfig = await this.dbService.getBaseConfig();
    const botToken = this.config.bot_token || baseConfig?.bot_token;
    const chatId = this.config.chat_id || baseConfig?.chat_id;

    if (!botToken || !chatId) {
      return {
        success: false,
        message: 'Telegram Bot Token 或 Chat ID 未配置'
      };
    }

    const telegramService = new TelegramService(this.dbService, botToken);
    const success = await telegramService.sendMessage(chatId, formatMarkdownMessage(post, matchedSub));

    return {
      success,
      message: success ? 'Telegram 通知发送成功' : 'Telegram 通知发送失败'
    };
  }

  async test(): Promise<NotificationSendResult> {
    const baseConfig = await this.dbService.getBaseConfig();
    const botToken = this.config.bot_token || baseConfig?.bot_token;
    const chatId = this.config.chat_id || baseConfig?.chat_id;

    if (!botToken) {
      return {
        success: false,
        message: 'Telegram Bot Token 未配置'
      };
    }

    const telegramService = new TelegramService(this.dbService, botToken);
    const botInfo = await telegramService.getBotInfo();
    if (!botInfo) {
      return {
        success: false,
        message: 'Telegram Bot Token 无效'
      };
    }

    if (!chatId) {
      return {
        success: true,
        message: 'Telegram Bot 连接正常，但 Chat ID 未绑定'
      };
    }

    const success = await telegramService.sendMessage(
      chatId,
      `**NodeSeek RSS 测试通知**\n\n时间: ${new Date().toLocaleString('zh-CN')}`
    );

    return {
      success,
      message: success ? 'Telegram 测试通知发送成功' : 'Telegram 测试通知发送失败'
    };
  }
}

class WebhookNotificationProvider implements NotificationProvider {
  constructor(private config: HttpChannelConfig) {}

  async send(post: Post, matchedSub: KeywordSub): Promise<NotificationSendResult> {
    const payload = {
      event: 'nodeseek.post.matched',
      post,
      subscription: matchedSub,
      message: formatPlainMessage(post, matchedSub),
      post_url: getPostUrl(post)
    };

    return sendJsonRequest(this.config, formatWebhookPayload(this.config.url || '', payload), 'Webhook 通知发送成功');
  }

  async test(): Promise<NotificationSendResult> {
    const payload = {
      event: 'nodeseek.notification.test',
      message: 'NodeSeek RSS Webhook 测试通知',
      sent_at: new Date().toISOString()
    };

    return sendJsonRequest(this.config, formatWebhookPayload(this.config.url || '', payload), 'Webhook 测试通知发送成功');
  }
}

class EmailNotificationProvider implements NotificationProvider {
  constructor(private config: HttpChannelConfig) {}

  async send(post: Post, matchedSub: KeywordSub): Promise<NotificationSendResult> {
    return sendJsonRequest(this.config, {
      to: this.config.to,
      from: this.config.from,
      subject: this.config.subject || `NodeSeek RSS: ${post.title}`,
      text: formatPlainMessage(post, matchedSub),
      html: formatHtmlMessage(post, matchedSub),
      post,
      subscription: matchedSub
    }, 'Email 通知发送成功');
  }

  async test(): Promise<NotificationSendResult> {
    return sendJsonRequest(this.config, {
      to: this.config.to,
      from: this.config.from,
      subject: this.config.subject || 'NodeSeek RSS 测试通知',
      text: `NodeSeek RSS Email 测试通知\n\n时间: ${new Date().toLocaleString('zh-CN')}`
    }, 'Email 测试通知发送成功');
  }
}

function parseConfig(configJson: string): Record<string, any> {
  try {
    return JSON.parse(configJson || '{}');
  } catch (error) {
    throw new Error(`通知渠道配置 JSON 无效: ${error}`);
  }
}

async function sendJsonRequest(config: HttpChannelConfig, payload: Record<string, any>, successMessage: string): Promise<NotificationSendResult> {
  if (!config.url) {
    return {
      success: false,
      message: '通知渠道 URL 未配置'
    };
  }

  try {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        success: false,
        message: '通知渠道 URL 仅支持 http 或 https'
      };
    }
  } catch {
    return {
      success: false,
      message: '通知渠道 URL 格式无效'
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers || {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseText = await response.text().catch(() => '');
    const responseJson = tryParseJson(responseText);
    const providerError = getProviderError(responseJson);

    if (!response.ok) {
      return {
        success: false,
        message: `请求失败: HTTP ${response.status}`,
        error: (providerError || responseText).slice(0, 500)
      };
    }

    if (providerError) {
      return {
        success: false,
        message: 'Webhook 服务返回失败',
        error: providerError.slice(0, 500)
      };
    }

    return {
      success: true,
      message: successMessage
    };
  } catch (error) {
    return {
      success: false,
      message: '请求异常',
      error: String(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatWebhookPayload(url: string, payload: Record<string, any>): Record<string, any> {
  if (isDingTalkWebhook(url)) {
    return {
      msgtype: 'text',
      text: {
        content: payload.message || JSON.stringify(payload)
      }
    };
  }

  return payload;
}

function isDingTalkWebhook(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === 'oapi.dingtalk.com' && parsedUrl.pathname.includes('/robot/send');
  } catch {
    return false;
  }
}

function tryParseJson(value: string): Record<string, any> | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getProviderError(responseJson: Record<string, any> | null): string | null {
  if (!responseJson) {
    return null;
  }

  if (typeof responseJson.errcode === 'number' && responseJson.errcode !== 0) {
    return responseJson.errmsg ? `DingTalk errcode ${responseJson.errcode}: ${responseJson.errmsg}` : `DingTalk errcode ${responseJson.errcode}`;
  }

  if (responseJson.ok === false) {
    return responseJson.message || responseJson.error || 'Webhook 返回 ok=false';
  }

  if (responseJson.success === false) {
    return responseJson.message || responseJson.error || 'Webhook 返回 success=false';
  }

  return null;
}

function formatMarkdownMessage(post: Post, matchedSub: KeywordSub): string {
  const keywords = [matchedSub.keyword1, matchedSub.keyword2, matchedSub.keyword3]
    .filter(k => k && k.trim().length > 0)
    .join(' ');
  const keywordsStr = keywords ? `🎯 ${keywords}` : '';
  const creator = matchedSub.creator ? `👤 ${matchedSub.creator}` : '';
  const category = matchedSub.category ? `🗂️ ${getCategoryName(matchedSub.category)}` : '';
  const title = post.title
    .replace(/\[/g, '「')
    .replace(/\]/g, '」')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');

  return `
**${keywordsStr} ${creator} ${category}**

**[${title}](${getPostUrl(post)})**
  `;
}

function formatPlainMessage(post: Post, matchedSub: KeywordSub): string {
  const keywords = [matchedSub.keyword1, matchedSub.keyword2, matchedSub.keyword3]
    .filter(Boolean)
    .join(' ');
  const lines = [
    'NodeSeek RSS 匹配通知',
    `标题: ${post.title}`,
    `链接: ${getPostUrl(post)}`,
    `作者: ${post.creator || '-'}`,
    `分类: ${matchedSub.category ? getCategoryName(matchedSub.category) : (post.category || '-')}`,
    keywords ? `关键词: ${keywords}` : ''
  ].filter(Boolean);

  return lines.join('\n');
}

function formatHtmlMessage(post: Post, matchedSub: KeywordSub): string {
  return `
    <h2>NodeSeek RSS 匹配通知</h2>
    <p><strong>标题:</strong> <a href="${escapeHtml(getPostUrl(post))}">${escapeHtml(post.title)}</a></p>
    <p><strong>作者:</strong> ${escapeHtml(post.creator || '-')}</p>
    <p><strong>分类:</strong> ${escapeHtml(matchedSub.category ? getCategoryName(matchedSub.category) : (post.category || '-'))}</p>
    <p>${escapeHtml(post.memo || '')}</p>
  `;
}

function getPostUrl(post: Post): string {
  return `https://www.nodeseek.com/post-${post.post_id}-1`;
}

function getCategoryName(category: string): string {
  const categoryMap: { [key: string]: string } = {
    daily: '日常',
    tech: '技术',
    info: '情报',
    review: '测评',
    trade: '交易',
    carpool: '拼车',
    promotion: '推广',
    life: '生活',
    dev: 'Dev',
    photo: '贴图',
    expose: '曝光',
    sandbox: '沙盒'
  };
  return categoryMap[category] || category;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
