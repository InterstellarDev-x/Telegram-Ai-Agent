import {
  telegramGetFileResponseSchema,
  type TelegramFile,
} from "../../contracts/telegram.ts";
import type { Logger } from "../../utils/logger.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_DEV_TELEGRAM_BOT_TOKEN =
  "8599626908:AAFXItwarN2ZkvXQGiPbwX9xami2tLmHZv8";

export interface TelegramSendMessageOptions {
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
}

export class TelegramBotClient {
  constructor(
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  async sendChatAction(chatId: number, action: "typing" | "upload_document"): Promise<void> {
    await this.request("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async sendTextMessage(
    chatId: number,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<void> {
    for (const chunk of splitPlainText(text, TELEGRAM_MAX_MESSAGE_LENGTH)) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        reply_to_message_id: options.replyToMessageId,
      });
    }
  }

  async sendHtmlMessage(
    chatId: number,
    html: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<void> {
    for (const chunk of splitHtmlMessage(html, 3900)) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: options.parseMode ?? "HTML",
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        reply_to_message_id: options.replyToMessageId,
      });
    }
  }

  async sendCodeMessage(
    chatId: number,
    code: string,
    language: string,
    intro?: string,
    replyToMessageId?: number,
  ): Promise<void> {
    if (intro) {
      await this.sendTextMessage(chatId, intro, { replyToMessageId });
    }

    const chunks = splitPlainText(code, 3400);
    for (let index = 0; index < chunks.length; index += 1) {
      const label =
        chunks.length > 1 ? `Part ${index + 1}/${chunks.length}\n` : "";
      const escaped = escapeHtml(chunks[index] ?? "");
      await this.sendHtmlMessage(
        chatId,
        `${label}<pre><code>${escaped}</code></pre>`,
        { replyToMessageId },
      );
    }

    if (chunks.length === 0) {
      await this.sendHtmlMessage(chatId, `<pre><code></code></pre>`, {
        replyToMessageId,
      });
    }

    this.logger.info("telegram-code-sent", {
      chatId,
      language,
      chunks: Math.max(chunks.length, 1),
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    const response = await this.request("getFile", {
      file_id: fileId,
    });
    const parsed = telegramGetFileResponseSchema.parse(response);

    if (!parsed.ok || !parsed.result?.file_path) {
      throw new Error(parsed.description ?? "Telegram getFile failed.");
    }

    return parsed.result;
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`,
    );

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with status ${response.status}.`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private async request(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        `Telegram API ${method} failed with status ${response.status}: ${JSON.stringify(
          payload,
        )}`,
      );
    }

    return payload;
  }
}

export function resolveTelegramBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN ?? DEFAULT_DEV_TELEGRAM_BOT_TOKEN;
}

export function createTelegramBotClient(logger: Logger): TelegramBotClient {
  const token = resolveTelegramBotToken();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  return new TelegramBotClient(token, logger.child("telegram-client"));
}

function splitPlainText(text: string, maxLength: number): string[] {
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const splitIndex = findSplitIndex(remaining, maxLength);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitHtmlMessage(html: string, maxLength: number): string[] {
  if (html.length <= maxLength) {
    return [html];
  }

  const prePrefix = "<pre><code>";
  const preSuffix = "</code></pre>";

  if (!html.startsWith(prePrefix) || !html.endsWith(preSuffix)) {
    return splitPlainText(html, maxLength);
  }

  const content = html.slice(prePrefix.length, -preSuffix.length);
  const available = maxLength - prePrefix.length - preSuffix.length;
  return splitPlainText(content, available).map(
    (chunk) => `${prePrefix}${chunk}${preSuffix}`,
  );
}

function findSplitIndex(text: string, maxLength: number): number {
  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= Math.floor(maxLength / 2)) {
    return newlineIndex + 1;
  }

  const whitespaceIndex = text.lastIndexOf(" ", maxLength);
  if (whitespaceIndex >= Math.floor(maxLength / 2)) {
    return whitespaceIndex + 1;
  }

  return maxLength;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
