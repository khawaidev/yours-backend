"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramService = void 0;
/**
 * Sends developer-facing notifications to a Telegram chat via a bot.
 *
 * Configured with BOT_TOKEN and CHAT_ID in backend/.env. Fails silently —
 * notifications must never break the calling request.
 */
class TelegramService {
    static isConfigured() {
        return Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID);
    }
    /**
     * Send a plain text message to the configured chat.
     * @returns true when the bot delivered the message.
     */
    static async sendMessage(text) {
        if (!this.isConfigured())
            return false;
        try {
            const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: process.env.CHAT_ID,
                    text: text.slice(0, 4000),
                    disable_web_page_preview: true,
                }),
            });
            if (!res.ok) {
                console.warn('[telegram] sendMessage failed:', res.status, (await res.text()).slice(0, 300));
                return false;
            }
            return true;
        }
        catch (err) {
            console.warn('[telegram] sendMessage error:', err?.message);
            return false;
        }
    }
}
exports.TelegramService = TelegramService;
