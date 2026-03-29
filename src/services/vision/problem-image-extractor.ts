import { z } from "zod";
import { createOpenAIClient } from "../llm/openai-client.ts";
import type { Logger } from "../../utils/logger.ts";

const extractedImageProblemSchema = z.object({
  questionText: z.string(),
  readability: z.enum(["clear", "unclear"]),
  coverage: z.enum(["complete", "partial"]),
  issues: z.array(z.string()).default([]),
});

export interface ProblemImageExtractionInput {
  imageBytes: Uint8Array;
  mimeType: string;
  caption?: string;
}

export interface ProblemImageExtractionResult {
  questionText: string;
  readability: "clear" | "unclear";
  coverage: "complete" | "partial";
  issues: string[];
}

export class ProblemImageExtractor {
  constructor(private readonly logger: Logger) {}

  async extractQuestion(
    input: ProblemImageExtractionInput,
  ): Promise<ProblemImageExtractionResult> {
    this.logger.info("image-extraction-started", {
      mimeType: input.mimeType,
      hasCaption: Boolean(input.caption),
      sizeBytes: input.imageBytes.byteLength,
    });

    const client = createOpenAIClient();
    const dataUrl = buildDataUrl(input.imageBytes, input.mimeType);
    const response = await client.responses.create({
      model: process.env.OPENAI_VISION_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1",
      temperature: 0,
      instructions: `
You extract coding problem statements from images for a backend solver.

Return a JSON object with these fields:
- questionText: the visible coding problem text reconstructed from this image only
- readability: "clear" if the text is readable enough to trust, otherwise "unclear"
- coverage: "complete" if this image appears to contain the whole problem, otherwise "partial"
- issues: short reasons if the image is blurry, cropped, obscured, or otherwise hard to read

Rules:
- Preserve the problem title, statement, examples, input/output blocks, and constraints.
- Preserve function signatures if they appear.
- Do not explain anything.
- Do not wrap the result in markdown.
- If the image contains only part of the question, return the visible text only and set coverage to "partial".
- If the image is blurry, cut off, low contrast, or not a coding problem, set readability to "unclear".
      `.trim(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input.caption?.trim()
                ? `Telegram caption or note from the user:\n${input.caption.trim()}`
                : "Extract the coding problem text from this image.",
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "extracted_problem",
          schema: {
              type: "object",
              additionalProperties: false,
              required: ["questionText", "readability", "coverage", "issues"],
              properties: {
                questionText: {
                  type: "string",
                },
                readability: {
                  type: "string",
                  enum: ["clear", "unclear"],
                },
                coverage: {
                  type: "string",
                  enum: ["complete", "partial"],
                },
                issues: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              },
            },
          },
      },
    });

    const outputText = response.output_text.trim();
    const parsed = extractedImageProblemSchema.parse(JSON.parse(outputText));

    this.logger.info("image-extraction-finished", {
      questionLength: parsed.questionText.length,
      readability: parsed.readability,
      coverage: parsed.coverage,
      requestId: response._request_id,
    });

    return {
      questionText: parsed.questionText.trim(),
      readability: parsed.readability,
      coverage: parsed.coverage,
      issues: parsed.issues,
    };
  }
}

function buildDataUrl(imageBytes: Uint8Array, mimeType: string): string {
  const base64 = Buffer.from(imageBytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}
