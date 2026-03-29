import { z } from "zod";
import { createOpenAIClient } from "../llm/openai-client.js";
import type { Logger } from "../../utils/logger.js";

const extractedImageProblemSchema = z.object({
  questionText: z.string(),
  starterTemplateText: z.string().default(""),
  readability: z.enum(["clear", "unclear"]),
  coverage: z.enum(["complete", "partial"]),
  imageKind: z
    .enum(["statement", "template", "mixed", "unknown"])
    .default("unknown"),
  visibleSections: z.array(z.string()).default([]),
  sections: z
    .object({
      title: z.string().default(""),
      statement: z.string().default(""),
      input: z.string().default(""),
      output: z.string().default(""),
      constraints: z.string().default(""),
      examples: z.string().default(""),
      notes: z.string().default(""),
    })
    .default({
      title: "",
      statement: "",
      input: "",
      output: "",
      constraints: "",
      examples: "",
      notes: "",
    }),
  issues: z.array(z.string()).default([]),
});

export interface ProblemImageExtractionInput {
  imageBytes: Uint8Array;
  mimeType: string;
  caption?: string;
}

export interface ProblemImageExtractionResult {
  questionText: string;
  starterTemplateText: string;
  readability: "clear" | "unclear";
  coverage: "complete" | "partial";
  imageKind: "statement" | "template" | "mixed" | "unknown";
  visibleSections: string[];
  sections: {
    title: string;
    statement: string;
    input: string;
    output: string;
    constraints: string;
    examples: string;
    notes: string;
  };
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
- starterTemplateText: starter code, predefined signature, class skeleton, or editor-visible boilerplate from this image only
- readability: "clear" if the text is readable enough to trust, otherwise "unclear"
- coverage: "complete" if this image appears to contain the whole problem, otherwise "partial"
- imageKind: "statement", "template", "mixed", or "unknown"
- visibleSections: short labels such as "title", "statement", "input format", "constraints", "sample tests", "template"
- sections: structured text buckets with keys title, statement, input, output, constraints, examples, notes
- issues: short reasons if the image is blurry, cropped, obscured, or otherwise hard to read

Rules:
- Preserve the problem title, difficulty label, statement, examples, input/output blocks, sample test cases, constraints, and explanations.
- Preserve any starter code, predefined function signatures, class names, or required method names if they appear.
- Preserve exact identifiers and structured sections such as "Input Format", "Output Format", "Sample Test Cases", and "Constraints".
- These are often competitive-programming problems, including hard and very hard ones where constraints are critical to the intended algorithm.
- Preserve constraints, bounds, notes, and explanation text very carefully because they may determine whether an O(n^2), O(n log n), DP, graph, greedy, or math solution is valid.
- These screenshots may show the problem statement on one side and a code editor or boilerplate template on the other side.
- If a code editor, starter template, function signature, or class skeleton is visible, extract it into starterTemplateText instead of mixing it into questionText.
- Ignore editor chrome, line numbers, tabs, sidebars, cursors, scrollbars, and UI labels unless they are part of the actual problem or starter code.
- Do not confuse sample-case labels, explanations, or template code with website UI text.
- questionText should contain only actual problem content. starterTemplateText should contain only the required code/template content.
- Put text into sections whenever possible. If a section is not visible, return an empty string for it.
- Normalize broken OCR whitespace only when needed for readability, but do not invent missing sections.
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
              required: [
                "questionText",
                "starterTemplateText",
                "readability",
                "coverage",
                "imageKind",
                "visibleSections",
                "sections",
                "issues",
              ],
              properties: {
                questionText: {
                  type: "string",
                },
                starterTemplateText: {
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
                imageKind: {
                  type: "string",
                  enum: ["statement", "template", "mixed", "unknown"],
                },
                visibleSections: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                sections: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "title",
                    "statement",
                    "input",
                    "output",
                    "constraints",
                    "examples",
                    "notes",
                  ],
                  properties: {
                    title: { type: "string" },
                    statement: { type: "string" },
                    input: { type: "string" },
                    output: { type: "string" },
                    constraints: { type: "string" },
                    examples: { type: "string" },
                    notes: { type: "string" },
                  },
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
      starterTemplateText: parsed.starterTemplateText.trim(),
      readability: parsed.readability,
      coverage: parsed.coverage,
      imageKind: parsed.imageKind,
      visibleSections: parsed.visibleSections,
      sections: {
        title: parsed.sections.title.trim(),
        statement: parsed.sections.statement.trim(),
        input: parsed.sections.input.trim(),
        output: parsed.sections.output.trim(),
        constraints: parsed.sections.constraints.trim(),
        examples: parsed.sections.examples.trim(),
        notes: parsed.sections.notes.trim(),
      },
      issues: parsed.issues,
    };
  }
}

function buildDataUrl(imageBytes: Uint8Array, mimeType: string): string {
  const base64 = Buffer.from(imageBytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}
