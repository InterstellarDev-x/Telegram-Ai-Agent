import OpenAI from "openai";

export interface OpenAIClientConfig {
  apiKey?: string;
}

export function createOpenAIClient(config: OpenAIClientConfig = {}): OpenAI {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  return new OpenAI({ apiKey });
}
