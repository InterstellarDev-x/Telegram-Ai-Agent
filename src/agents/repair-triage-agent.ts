import { z } from "zod";
import type {
  GenerationFeedback,
  SolutionCandidate,
} from "../contracts/agents.js";
import type { StreamedSolveRequest } from "../contracts/http.js";
import type { ProblemImageAsset } from "../contracts/problem.js";
import { generateGeminiJson } from "../services/llm/gemini-json.js";
import type { Logger } from "../utils/logger.js";
import {
  compactProblemStatement,
  estimatePromptChars,
  truncateMiddle,
} from "../utils/prompt-compaction.js";

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

const repairTriageGeminiSchema = {
  type: "OBJECT",
  properties: {
    needsRepair: { type: "BOOLEAN" },
    evidenceSummary: { type: "STRING" },
    rootCause: { type: "STRING" },
    actionItems: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    failingCases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          input: { type: "STRING" },
          expectedOutput: { type: "STRING" },
          actualOutput: { type: "STRING" },
          source: { type: "STRING" },
        },
        required: ["name", "input", "expectedOutput", "actualOutput", "source"],
        propertyOrdering: ["name", "input", "expectedOutput", "actualOutput", "source"],
      },
    },
  },
  required: [
    "needsRepair",
    "evidenceSummary",
    "rootCause",
    "actionItems",
    "failingCases",
  ],
  propertyOrdering: [
    "needsRepair",
    "evidenceSummary",
    "rootCause",
    "actionItems",
    "failingCases",
  ],
} as const;

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

    const prompt = buildRepairTriagePrompt(input);
    this.logger.info("repair-triage-context-compacted", {
      promptChars: estimatePromptChars(prompt),
      feedbackTexts: input.userFeedbackTexts.length,
      feedbackImages: input.feedbackImageAssets.length,
    });
    const parsed = await generateGeminiJson({
      model:
        process.env.GEMINI_VISION_MODEL?.trim() ||
        process.env.GEMINI_MODEL?.trim() ||
        "gemini-2.5-flash",
      prompt: `
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
${prompt}
      `.trim(),
      imageDataUrls: input.feedbackImageAssets.map((asset) => asset.dataUrl),
      schema: repairTriageGeminiSchema,
      parse: (value) => repairTriageSchema.parse(value),
    });
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
${compactProblemStatement(input.request.statement, 5_000)}

Current code:
${truncateMiddle(input.candidate.code, 5_000)}

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
