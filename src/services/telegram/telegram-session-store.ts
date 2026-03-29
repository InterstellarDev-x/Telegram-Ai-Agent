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
  private readonly sessions = new Map<number, TelegramChatSession>();

  get(chatId: number): TelegramChatSession {
    return (
      this.sessions.get(chatId) ?? {
        mode: "idle",
        images: [],
        updatedAt: new Date().toISOString(),
      }
    );
  }

  startCollecting(chatId: number): TelegramChatSession {
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [],
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    return session;
  }

  addImage(chatId: number, image: PendingTelegramImage): TelegramChatSession {
    const current = this.get(chatId);
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [...current.images, image],
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    return session;
  }

  startProcessing(chatId: number): TelegramChatSession {
    const current = this.get(chatId);
    const session: TelegramChatSession = {
      ...current,
      mode: "processing",
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    return session;
  }

  reset(chatId: number): TelegramChatSession {
    const session: TelegramChatSession = {
      mode: "idle",
      images: [],
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    return session;
  }

  resetToCollecting(chatId: number): TelegramChatSession {
    const session: TelegramChatSession = {
      mode: "collecting",
      images: [],
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    return session;
  }
}

export const telegramSessionStore = new TelegramSessionStore();
