interface UpstashResult<TValue> {
  result: TValue;
}

export class UpstashRedisClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async get(key: string): Promise<string | null> {
    const payload = await this.execute<string | null>(["GET", key]);
    return payload.result;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const command = ["SET", key, value];

    if (ttlSeconds && ttlSeconds > 0) {
      command.push("EX", String(ttlSeconds));
    }

    await this.execute(command);
  }

  async getJson<TValue>(key: string): Promise<TValue | null> {
    const raw = await this.get(key);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as TValue;
  }

  async setJson<TValue>(key: string, value: TValue, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.execute(["DEL", key]);
  }

  private async execute<TValue>(segments: string[]): Promise<UpstashResult<TValue>> {
    const response = await fetch(
      `${this.baseUrl}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Upstash request failed with status ${response.status}.`);
    }

    return (await response.json()) as UpstashResult<TValue>;
  }
}

export function createUpstashRedisClient(): UpstashRedisClient {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!baseUrl || !token) {
    throw new Error("Upstash Redis credentials are required.");
  }

  return new UpstashRedisClient(baseUrl, token);
}
