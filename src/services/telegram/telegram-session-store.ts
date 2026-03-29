import { createUpstashRedisClient } from "../storage/upstash-redis.js";

export interface PendingTelegramImage {
  fileId: string;
  mimeType?: string;
  caption?: string;
  source: "photo" | "document";
  receivedAt: string;
}

export interface TelegramChatSession {
  mode: "idle" | "collecting" | "processing";
  images: PendingTelegramImage[];
  updatedAt: string;
}

export class TelegramSessionStore {
  private readonly redis = createUpstashRedisClient();
  private readonly ttlSeconds = 60 * 60;

  async get(chatId: number): Promise<TelegramChatSession> {
    const raw = await this.redis.get(this.buildKey(chatId));

    if (!raw) {
      return createIdleSession();
    }

    try {
      return JSON.parse(raw) as TelegramChatSession;
    } catch {
      return createIdleSession();
    }
  }

  async startCollecting(chatId: number): Promise<TelegramChatSession> {
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [],
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  async addImage(
    chatId: number,
    image: PendingTelegramImage,
  ): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [...current.images, image],
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  async startProcessing(chatId: number): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    const session: TelegramChatSession = {
      ...current,
      mode: "processing",
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  async reset(chatId: number): Promise<TelegramChatSession> {
    await this.redis.del(this.buildKey(chatId));
    return createIdleSession();
  }

  async resetToCollecting(chatId: number): Promise<TelegramChatSession> {
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [],
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  private buildKey(chatId: number): string {
    return `telegram:session:${chatId}`;
  }

  private async write(chatId: number, session: TelegramChatSession): Promise<void> {
    await this.redis.set(
      this.buildKey(chatId),
      JSON.stringify(session),
      this.ttlSeconds,
    );
  }
}

export const telegramSessionStore = new TelegramSessionStore();

function createIdleSession(): TelegramChatSession {
  return {
    mode: "idle",
    images: [],
    updatedAt: new Date().toISOString(),
  };
}
