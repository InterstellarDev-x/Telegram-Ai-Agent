import { ChatOpenAI } from "@langchain/openai";

export interface OpenAIChatModelConfig {
  model?: string;
  temperature?: number;
  apiKey?: string;
}

export function createOpenAIChatModel(
  config: OpenAIChatModelConfig = {},
): ChatOpenAI {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required to use the DeepAgent-backed generator/tester.",
    );
  }

  return new ChatOpenAI({
    apiKey,
    model: config.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: config.temperature ?? 0,
  });
}
