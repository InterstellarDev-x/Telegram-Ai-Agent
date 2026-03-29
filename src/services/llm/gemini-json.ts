import { GeminiHttpError, getPooledGeminiClient } from "./key-pool/pooled-gemini-client.js";

export type GeminiResponseSchema = Record<string, unknown>;

export interface GeminiJsonInput<T> {
  prompt: string;
  schema: GeminiResponseSchema;
  parse: (value: unknown) => T;
  model?: string;
  imageDataUrls?: string[];
  temperature?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

export async function generateGeminiJson<T>(
  input: GeminiJsonInput<T>,
): Promise<T> {
  const pooledClient = getPooledGeminiClient();
  const model = input.model?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const response = await pooledClient.withKey(async (apiKey) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: input.prompt,
                },
                ...(input.imageDataUrls ?? []).map(dataUrlToInlineDataPart),
              ],
            },
          ],
          generationConfig: {
            temperature: input.temperature ?? 0,
            response_mime_type: "application/json",
            response_schema: input.schema,
          },
        }),
      },
    );

    if (!res.ok) {
      throw new GeminiHttpError(res.status, await res.text());
    }

    return res;
  });

  const body = (await response.json()) as GeminiGenerateContentResponse;
  const rawText = extractGeminiText(body).trim();
  if (!rawText) {
    throw new Error("Gemini returned an empty structured response.");
  }

  return input.parse(JSON.parse(rawText));
}

function dataUrlToInlineDataPart(dataUrl: string): {
  inline_data: {
    mime_type: string;
    data: string;
  };
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data URL supplied to Gemini.");
  }

  const mimeType = match[1];
  const data = match[2];
  if (!mimeType || !data) {
    throw new Error("Incomplete image data URL supplied to Gemini.");
  }
  return {
    inline_data: {
      mime_type: mimeType,
      data,
    },
  };
}

function extractGeminiText(response: GeminiGenerateContentResponse): string {
  return (
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("") ?? ""
  );
}
