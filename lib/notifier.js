// Telegram notifier
export class TelegramNotifier {
  constructor({ botToken, chatId }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId);
  }
  async send(text) {
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      });
    } catch (e) {
      console.error('[telegram] send failed:', e.message);
    }
  }
}
