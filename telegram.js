/**
 * telegram.js — Resilient Telegram Bot Dispatcher
 * Dispatches Markdown-formatted alerts to private chats and groups with retry & backoff.
 */
const https = require('https');
const db = require('./db');

class TelegramDispatcher {
  constructor() {
    this.maxRetries = 3;
    this.initialBackoffMs = 1000;
  }

  getCredentials() {
    const token = process.env.TELEGRAM_BOT_TOKEN || db.getSetting('telegram_bot_token', '');
    const chatId = process.env.TELEGRAM_CHAT_ID || db.getSetting('telegram_chat_id', '');
    return { token: token.trim(), chatId: chatId.trim() };
  }

  /**
   * Sends raw message via Telegram Bot API with retry and rate limit handling
   */
  async sendMessage(text, customToken = null, customChatId = null) {
    const creds = this.getCredentials();
    const botToken = customToken || creds.token;
    const chatId = customChatId || creds.chatId;

    if (!botToken || !chatId) {
      return { ok: false, error: 'Telegram Bot Token or Chat ID not configured' };
    }

    let attempt = 0;
    let delay = this.initialBackoffMs;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        const result = await this.httpPost(botToken, chatId, text);
        if (result.ok) {
          return { ok: true, messageId: result.result?.message_id };
        }

        // Check for rate limit 429
        if (result.error_code === 429 && result.parameters?.retry_after) {
          const waitTime = (result.parameters.retry_after + 1) * 1000;
          console.warn(`[Telegram] Rate limited (429). Waiting ${waitTime}ms before retry...`);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }

        // Bad request / non-retryable error
        if (result.error_code >= 400 && result.error_code < 500) {
          return { ok: false, error: result.description || `HTTP ${result.error_code}` };
        }

        // Transient error — wait backoff
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      } catch (networkErr) {
        if (attempt >= this.maxRetries) {
          return { ok: false, error: networkErr.message || 'Network timeout or unreachable host' };
        }
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }

    return { ok: false, error: `Failed after ${this.maxRetries} attempts` };
  }

  httpPost(botToken, chatId, text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (e) {
            resolve({ ok: false, error_code: res.statusCode, description: body || 'Invalid JSON response' });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telegram request timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Formats a clean HTML/Markdown notification for a triggered alert
   */
  formatAlertMessage(alertData) {
    const { rule, alert, snapshot } = alertData;
    const isCandleClose = alert.is_candle_close === 1 || alert.is_candle_close === true;
    const triggerType = isCandleClose ? '🔔 <b>CANDLE CLOSE CONFIRMED</b>' : '⚡ <b>INTRABAR TICK TRIGGER</b>';

    const ohlcv = snapshot?.ohlcv || {};
    const ohlcvStr = [
      `<b>O:</b> ${ohlcv.open ?? '—'}`,
      `<b>H:</b> ${ohlcv.high ?? '—'}`,
      `<b>L:</b> ${ohlcv.low ?? '—'}`,
      `<b>C:</b> ${ohlcv.close ?? '—'}`,
      `<b>V:</b> ${ohlcv.volume ?? '—'}`
    ].join(' | ');

    // Extract formatted indicator values
    const indicatorLines = [];
    if (snapshot?.indicators && typeof snapshot.indicators === 'object') {
      for (const [indKey, indObj] of Object.entries(snapshot.indicators)) {
        if (indObj.plots && typeof indObj.plots === 'object') {
          const plotParts = [];
          for (const [plotKey, p] of Object.entries(indObj.plots)) {
            if (p.value !== null && p.value !== undefined) {
              plotParts.push(`${plotKey}: <code>${p.value}</code>`);
            }
          }
          if (plotParts.length > 0) {
            indicatorLines.push(`• <b>${indObj.name || indKey}:</b> ${plotParts.join(', ')}`);
          }
        }
      }
    }

    const indText = indicatorLines.length > 0 
      ? `\n\n📊 <b>Active Indicators:</b>\n${indicatorLines.slice(0, 10).join('\n')}` 
      : '';

    const timestamp = new Date(alert.triggered_at || Date.now()).toUTCString();

    return [
      `${triggerType}`,
      `<b>Rule:</b> ${rule.name}`,
      `<b>Symbol:</b> <code>${db.cleanSymbol(rule.symbol)}</code>  |  <b>TF:</b> <code>${db.cleanTimeframe(rule.timeframe)}</code>`,
      `<b>Time:</b> ${timestamp}`,
      `\n📈 <b>Price:</b>\n${ohlcvStr}`,
      indText,
      `\n<i>TradingView Multi-Condition Alert Generator</i>`
    ].join('\n');
  }

  /**
   * Sends rich embed to a Discord Webhook
   */
  async sendDiscord(webhookUrl, alertData) {
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return { ok: false, error: 'Invalid Discord Webhook URL' };
    }

    const { rule, alert, snapshot } = alertData;
    const isCandleClose = alert.is_candle_close === 1 || alert.is_candle_close === true;
    const color = isCandleClose ? 0x26a69a : 0xffa726;
    const ohlcv = snapshot?.ohlcv || {};

    const fields = [
      { name: 'Symbol', value: `\`${rule.symbol}\``, inline: true },
      { name: 'Timeframe', value: `\`${rule.timeframe}\``, inline: true },
      { name: 'Type', value: isCandleClose ? '🔔 Candle Close' : '⚡ Intrabar Tick', inline: true },
      { name: 'Price (Close)', value: `\`${ohlcv.close ?? '—'}\``, inline: true },
      { name: 'O / H / L', value: `${ohlcv.open ?? '—'} / ${ohlcv.high ?? '—'} / ${ohlcv.low ?? '—'}`, inline: true },
      { name: 'Volume', value: `${ohlcv.volume != null ? Number(ohlcv.volume).toLocaleString() : '—'}`, inline: true },
    ];

    if (snapshot?.indicators && typeof snapshot.indicators === 'object') {
      const indLines = [];
      for (const [k, obj] of Object.entries(snapshot.indicators)) {
        if (obj.plots) {
          const vals = Object.entries(obj.plots)
            .filter(([_, p]) => p.value != null)
            .map(([pn, p]) => `${pn}: ${p.value}`);
          if (vals.length > 0) indLines.push(`**${obj.name || k}**: ${vals.join(', ')}`);
        }
      }
      if (indLines.length > 0) {
        fields.push({ name: 'Indicators', value: indLines.slice(0, 6).join('\n') });
      }
    }

    const payload = JSON.stringify({
      username: 'TradingView Alert Bot',
      avatar_url: 'https://www.tradingview.com/static/images/favicon.ico',
      embeds: [{
        title: `🚨 Alert: ${rule.name}`,
        color,
        fields,
        footer: { text: 'TradingView Advanced Multi-Condition Alert Generator' },
        timestamp: new Date(alert.triggered_at || Date.now()).toISOString()
      }]
    });

    try {
      const u = new URL(webhookUrl);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (r) => {
          let b = '';
          r.on('data', d => { b += d; });
          r.on('end', () => resolve({ status: r.statusCode, body: b }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Dispatches an alert across all configured channels (Telegram, Discord, Webhook)
   */
  async dispatchAlert(alertData) {
    const results = {};

    // 1. Telegram
    const tgMessage = this.formatAlertMessage(alertData);
    results.telegram = await this.sendMessage(tgMessage);

    if (alertData.alert?.id) {
      db.updateAlertTelegramStatus(
        alertData.alert.id,
        results.telegram.ok,
        results.telegram.ok ? null : results.telegram.error
      );
    }

    // 2. Discord Webhook (if configured)
    const discordUrl = process.env.DISCORD_WEBHOOK_URL || db.getSetting('discord_webhook_url', '');
    if (discordUrl && discordUrl.trim()) {
      results.discord = await this.sendDiscord(discordUrl.trim(), alertData);
    }

    // 3. Generic Webhook (if configured)
    const genericWebhook = process.env.GENERIC_WEBHOOK_URL || db.getSetting('generic_webhook_url', '');
    if (genericWebhook && genericWebhook.trim()) {
      results.generic = await this.sendGenericWebhook(genericWebhook.trim(), alertData);
    }

    return results;
  }

  async sendGenericWebhook(url, alertData) {
    try {
      const u = new URL(url);
      const payload = JSON.stringify(alertData);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (r) => {
          r.on('data', () => {});
          r.on('end', () => resolve({ status: r.statusCode }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Verifies credentials by sending a test message
   */
  async testConnection(botToken, chatId) {
    const text = `✅ <b>TradingView Alert Generator Test</b>\nConnection established successfully at ${new Date().toISOString()}`;
    return await this.sendMessage(text, botToken, chatId);
  }
}

module.exports = new TelegramDispatcher();
