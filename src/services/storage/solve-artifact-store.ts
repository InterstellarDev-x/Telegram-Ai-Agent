import { createUpstashRedisClient } from "./upstash-redis.js";

export interface SolveArtifactRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: "ingested" | "parsed" | "solved" | "failed";
  chatId?: number;
  title?: string;
  targetLanguage?: string;
  extraction?: {
    imageCount: number;
    warnings: string[];
    segmentKinds: string[];
    normalizedQuestion: string;
  };
  parse?: {
    detectedStyle: string;
    notes: string[];
    alternateSolveRequests: number;
  };
  solve?: {
    status: string;
    attemptsUsed: number;
    providers: string[];
    verdict: string;
  };
}

export class SolveArtifactStore {
  private readonly redis = createUpstashRedisClient();
  private readonly ttlSeconds = 60 * 60 * 24;

  async put(record: SolveArtifactRecord): Promise<void> {
    await this.redis.setJson(this.buildKey(record.id), record, this.ttlSeconds);
  }

  async patch(
    id: string,
    patch: Partial<Omit<SolveArtifactRecord, "id" | "createdAt">>,
  ): Promise<SolveArtifactRecord | null> {
    const current = await this.redis.getJson<SolveArtifactRecord>(this.buildKey(id));
    if (!current) {
      return null;
    }

    const next: SolveArtifactRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.put(next);
    return next;
  }

  private buildKey(id: string): string {
    return `solve:artifact:${id}`;
  }
}

export const solveArtifactStore = new SolveArtifactStore();
