import { createUpstashRedisClient } from "../storage/upstash-redis.js";
import type { GenerationFeedback, SolutionCandidate, TestingReport } from "../../contracts/agents.js";
import type {
  ParsedProblemBlueprint,
  RawQuestionRequest,
  StreamedSolveRequest,
} from "../../contracts/http.js";

export interface PendingTelegramImage {
  fileId: string;
  mimeType?: string;
  caption?: string;
  source: "photo" | "document";
  receivedAt: string;
}

export interface TelegramChatSession {
  mode: "idle" | "collecting" | "processing" | "awaiting_feedback";
  images: PendingTelegramImage[];
  status: {
    phase: string;
    detail: string;
    updatedAt: string;
  };
  followUp?: {
    rawQuestionRequest: RawQuestionRequest;
    solveRequest: StreamedSolveRequest;
    blueprint: ParsedProblemBlueprint;
    currentCandidate: SolutionCandidate;
    currentReport: TestingReport;
    feedbackImages: PendingTelegramImage[];
    feedbackTexts: string[];
    feedbackHistory: GenerationFeedback[];
    previousCandidates: SolutionCandidate[];
    iterations: number;
  };
  updatedAt: string;
}

const sessionModes = new Set<TelegramChatSession["mode"]>([
  "idle",
  "collecting",
  "processing",
  "awaiting_feedback",
]);

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
      status: {
        phase: "collecting",
        detail: "Waiting for problem images.",
        updatedAt: new Date().toISOString(),
      },
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
    if (current.mode === "awaiting_feedback" && current.followUp) {
      const session: TelegramChatSession = {
        ...current,
        followUp: {
          ...current.followUp,
          feedbackImages: [...current.followUp.feedbackImages, image],
        },
        status: {
          phase: "awaiting_feedback",
          detail: "Waiting for more feedback images or text, or send 2 to re-check the current code.",
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };

      await this.write(chatId, session);
      return session;
    }

    const session: TelegramChatSession = {
      mode: "collecting",
      images: [...current.images, image],
      status: {
        phase: "collecting",
        detail: "Collecting problem images.",
        updatedAt: new Date().toISOString(),
      },
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
      status: {
        phase: "processing",
        detail: "Processing the current request.",
        updatedAt: new Date().toISOString(),
      },
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
      status: {
        phase: "collecting",
        detail: "Waiting for problem images.",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  private buildKey(chatId: number): string {
    return `telegram:session:${chatId}`;
  }

  async setAwaitingFeedback(
    chatId: number,
    context: NonNullable<TelegramChatSession["followUp"]>,
  ): Promise<TelegramChatSession> {
    const session: TelegramChatSession = {
      mode: "awaiting_feedback",
      images: [],
      followUp: context,
      status: {
        phase: "awaiting_feedback",
        detail:
          "Code sent. Waiting for error screenshots/text, 4 to finish, or 5 to reset.",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  async addFeedbackText(chatId: number, text: string): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    if (current.mode !== "awaiting_feedback" || !current.followUp) {
      return current;
    }

    const session: TelegramChatSession = {
      ...current,
      followUp: {
        ...current.followUp,
        feedbackTexts: [...current.followUp.feedbackTexts, text],
      },
      status: {
        phase: "awaiting_feedback",
        detail: "Feedback note saved. Send more details or send 2 to re-check the current code.",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };

    await this.write(chatId, session);
    return session;
  }

  async clearFollowUpFeedback(chatId: number): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    if (!current.followUp) {
      return current;
    }

    const session: TelegramChatSession = {
      ...current,
      followUp: {
        ...current.followUp,
        feedbackImages: [],
        feedbackTexts: [],
      },
      updatedAt: new Date().toISOString(),
    };
    await this.write(chatId, session);
    return session;
  }

  async updateFollowUpAfterRepair(
    chatId: number,
    patch: Partial<NonNullable<TelegramChatSession["followUp"]>>,
  ): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    if (!current.followUp) {
      return current;
    }

    const session: TelegramChatSession = {
      ...current,
      mode: "awaiting_feedback",
      followUp: {
        ...current.followUp,
        ...patch,
      },
      status: {
        phase: "awaiting_feedback",
        detail:
          "Updated code is ready. Send more error screenshots/text, 4 to finish, or 5 to reset.",
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.write(chatId, session);
    return session;
  }

  async updateStatus(
    chatId: number,
    phase: string,
    detail: string,
  ): Promise<TelegramChatSession> {
    const current = await this.get(chatId);
    const nextMode = sessionModes.has(phase as TelegramChatSession["mode"])
      ? (phase as TelegramChatSession["mode"])
      : current.mode;
    const session: TelegramChatSession = {
      ...current,
      mode: nextMode,
      status: {
        phase,
        detail,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.write(chatId, session);
    return session;
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
    status: {
      phase: "idle",
      detail: "No active problem. Send 1 to start a new session.",
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}
