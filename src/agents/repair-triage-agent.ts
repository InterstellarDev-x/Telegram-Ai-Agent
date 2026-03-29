import { z } from "zod";
import type {
  GenerationFeedback,
  SolutionCandidate,
} from "../contracts/agents.js";
import type { StreamedSolveRequest } from "../contracts/http.js";
import type { ProblemImageAsset } from "../contracts/problem.js";
import { createOpenAIClient } from "../services/llm/openai-client.js";
import type { Logger } from "../utils/logger.js";

const repairTriageSchema = z.object({
  needsRepair: z.boolean(),
  evidenceSummary: z.string().default(""),
  rootCause: z.string().default(""),
  actionItems: z.array(z.string()).default([]),
  failingCases: z
    .array(
      z.object({
        name: z.string().default(""),
        input: z.string().default(""),
        expectedOutput: z.string().default(""),
        actualOutput: z.string().default(""),
        source: z.string().default(""),
      }),
    )
    .default([]),
});

export interface RepairTriageInput {
  request: StreamedSolveRequest;
  candidate: SolutionCandidate;
  userFeedbackTexts: string[];
  feedbackImageAssets: ProblemImageAsset[];
  previousVerdict?: string;
}

export interface RepairTriageResult {
  needsRepair: boolean;
  evidenceSummary: string;
  feedback?: GenerationFeedback;
}

export class RepairTriageAgent {
  constructor(private readonly logger: Logger) {}

  async triage(input: RepairTriageInput): Promise<RepairTriageResult> {
    if (
      input.userFeedbackTexts.length === 0 &&
      input.feedbackImageAssets.length === 0
    ) {
      return {
        needsRepair: false,
        evidenceSummary: "No new follow-up evidence was attached.",
      };
    }

    this.logger.info("repair-triage-started", {
      feedbackTexts: input.userFeedbackTexts.length,
      feedbackImages: input.feedbackImageAssets.length,
    });

    const client = createOpenAIClient();
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "high" }
    > = [
      {
        type: "input_text",
        text: buildRepairTriagePrompt(input),
      },
      ...input.feedbackImageAssets.map((asset) => ({
        type: "input_image" as const,
        image_url: asset.dataUrl,
        detail: "high" as const,
      })),
    ];

    const response = await client.responses.create({
      model:
        process.env.OPENAI_VISION_MODEL ??
        process.env.OPENAI_MODEL ??
        "gpt-4.1",
      temperature: 0,
      instructions: `
You are the Repair Triage Agent for a competitive-programming code solver.

Your job is to analyze follow-up user evidence after code was already generated.

Rules:
- Treat the new feedback screenshots and user feedback text as the primary evidence.
- The problem statement and current code are context.
- Detect whether the new evidence suggests a compile error, runtime error, wrong answer, interface mismatch, template mismatch, or insufficient evidence.
- If the evidence is actionable, set needsRepair=true and produce concise action items for the next repair attempt.
- If the evidence is weak, contradictory, or does not clearly prove a defect, set needsRepair=false.
- rootCause must be concise and concrete when needsRepair=true.
- failingCases may be empty when exact IO cannot be recovered from the evidence.
- Return only JSON matching the schema.
      `.trim(),
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "repair_triage",
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "needsRepair",
              "evidenceSummary",
              "rootCause",
              "actionItems",
              "failingCases",
            ],
            properties: {
              needsRepair: { type: "boolean" },
              evidenceSummary: { type: "string" },
              rootCause: { type: "string" },
              actionItems: {
                type: "array",
                items: { type: "string" },
              },
              failingCases: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "name",
                    "input",
                    "expectedOutput",
                    "actualOutput",
                    "source",
                  ],
                  properties: {
                    name: { type: "string" },
                    input: { type: "string" },
                    expectedOutput: { type: "string" },
                    actualOutput: { type: "string" },
                    source: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const parsed = repairTriageSchema.parse(JSON.parse(response.output_text.trim()));
    const evidenceSummary =
      parsed.evidenceSummary.trim() ||
      (parsed.needsRepair
        ? "The follow-up evidence suggests the current code needs changes."
        : "The follow-up evidence does not clearly prove a defect.");
    const actionItems = parsed.actionItems
      .map((item) => item.trim())
      .filter(Boolean);
    const rootCause = parsed.rootCause.trim();

    const result: RepairTriageResult = {
      needsRepair: parsed.needsRepair,
      evidenceSummary,
    };

    if (parsed.needsRepair) {
      result.feedback = {
        summary: evidenceSummary,
        rootCause: rootCause || evidenceSummary,
        actionItems:
          actionItems.length > 0
            ? actionItems
            : ["Address the defect shown in the user's follow-up evidence."],
        failingCases: parsed.failingCases.map((failure, index) => ({
          name: failure.name.trim() || `follow-up-case-${index + 1}`,
          input: failure.input.trim(),
          expectedOutput: failure.expectedOutput.trim(),
          actualOutput: failure.actualOutput.trim(),
          source: failure.source.trim() || "follow-up",
        })),
      };
    }

    this.logger.info("repair-triage-finished", {
      needsRepair: result.needsRepair,
    });

    return result;
  }
}

function buildRepairTriagePrompt(input: RepairTriageInput): string {
  const feedbackText =
    input.userFeedbackTexts.length === 0
      ? "No explicit follow-up text."
      : input.userFeedbackTexts.map((text) => `- ${text}`).join("\n");

  return `
Problem title:
${input.request.title}

Problem statement:
${input.request.statement}

Current code:
${input.candidate.code}

Current code strategy:
${input.candidate.strategy}

Previous verifier verdict:
${input.previousVerdict ?? "No previous verifier verdict."}

User follow-up text:
${feedbackText}

Feedback screenshots attached: ${input.feedbackImageAssets.length}

Decide whether the new evidence suggests the current code actually needs repair.
If yes, summarize the defect and provide concrete action items for the next repair attempt.
  `.trim();
}
