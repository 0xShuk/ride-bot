// Telegram alerts. Without a token and chat id, messages go to the log only.

export class Telegram {
  constructor(
    private token: string | undefined,
    private chat: string | undefined,
  ) {}

  async send(text: string): Promise<void> {
    console.log(`[tg] ${text.replace(/\n/g, " | ")}`);
    if (!this.token || !this.chat) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[tg] send failed ${res.status}`);
    } catch (e) {
      console.error("[tg] send failed", e);
    }
  }
}
