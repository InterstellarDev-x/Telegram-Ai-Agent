import { z } from "zod";
import { DeepAgentCodeGenerationAgent } from "../../agents/deep-code-generation-agent.js";
import { SupervisorAgent } from "../../agents/supervisor-agent.js";
import type {
  CodeTestingAgent,
  GenerationFeedback,
  TestSolutionInput,
  TestingReport,
} from "../../contracts/agents.js";
import type { StreamedSolveRequest } from "../../contracts/http.js";
import { buildProblemFromHttpRequest } from "../../contracts/http.js";
import { InMemoryAgentTransport } from "../agent-transport.js";
import { createOpenAIChatModel } from "../llm/openai-chat-model.js";
import { createOpenAIClient } from "../llm/openai-client.js";
import type { Logger } from "../../utils/logger.js";

const llmVerificationSchema = z.object({
  passed: z.boolean(),
  verdict: z.string().min(1),
  rootCause: z.string().min(1),
  actionItems: z.array(z.string()).default([]),
  failingCases: z
    .array(
      z.object({
        name: z.string(),
        input: z.string(),
        expectedOutput: z.string(),
        actualOutput: z.string(),
        source: z.string(),
      }),
    )
    .default([]),
});

class ImageAwareCodeTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;

  constructor(private readonly logger: Logger) {}

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", {
      attempt: input.attempt,
      language: input.candidate.language,
      imageAssets: input.problem.imageAssets.length,
    });

    const client = createOpenAIClient();
    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "high" }
    > = [
      {
        type: "input_text",
        text: buildVerificationPrompt(input),
      },
      ...input.problem.imageAssets.map((asset) => ({
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
You are the Code Verification Agent for a coding-problem solver.

Your job is to decide whether the submitted code correctly solves the coding problem.

Rules:
- Treat the original problem images as the highest-priority source of truth.
- Use the reconstructed text problem statement as supporting context.
- Review the candidate code logically. You do not need to execute it.
- Be conservative: mark passed=true only if the code clearly solves the shown problem.
- If the code is wrong, incomplete, or mismatched to the screenshots, mark passed=false.
- rootCause must be a short concrete explanation of the main defect or uncertainty.
- actionItems must be specific instructions for the next generation attempt.
- failingCases may be empty if exact I/O cannot be derived confidently from the screenshots.
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
          name: "llm_code_verification",
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "passed",
              "verdict",
              "rootCause",
              "actionItems",
              "failingCases",
            ],
            properties: {
              passed: {
                type: "boolean",
              },
              verdict: {
                type: "string",
              },
              rootCause: {
                type: "string",
              },
              actionItems: {
                type: "array",
                items: {
                  type: "string",
                },
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
                    name: {
                      type: "string",
                    },
                    input: {
                      type: "string",
                    },
                    expectedOutput: {
                      type: "string",
                    },
                    actualOutput: {
                      type: "string",
                    },
                    source: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const review = llmVerificationSchema.parse(JSON.parse(response.output_text.trim()));

    if (review.passed) {
      this.logger.info("testing-passed", {
        attempt: input.attempt,
        requestId: response._request_id,
      });

      return {
        status: "passed",
        verdict: review.verdict,
        executedCases: [],
      };
    }

    this.logger.warn("testing-failed", {
      attempt: input.attempt,
      requestId: response._request_id,
      failingCases: review.failingCases.length,
    });

    const feedback: GenerationFeedback = {
      summary: review.verdict,
      rootCause: review.rootCause,
      actionItems:
        review.actionItems.length > 0
          ? review.actionItems
          : [
              "Re-read the problem statement and screenshots carefully.",
              "Fix the logic mismatch identified by the verification review.",
            ],
      failingCases: review.failingCases,
    };

    return {
      status: "failed",
      verdict: review.verdict,
      executedCases: [],
      feedback,
    };
  }
}

export async function solveWithFunctionHarness(
  request: StreamedSolveRequest,
  logger: Logger,
): Promise<Awaited<ReturnType<SupervisorAgent["solve"]>>> {
  const model = createOpenAIChatModel({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: 0,
  });

  const supervisor = new SupervisorAgent({
    generator: new DeepAgentCodeGenerationAgent(model, logger),
    tester: new ImageAwareCodeTestingAgent(logger.child("image-aware-tester")),
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  return await supervisor.solve({
    problem: buildProblemFromHttpRequest(request),
    maxAttempts: request.maxAttempts,
  });
}

function buildVerificationPrompt(input: TestSolutionInput): string {
  const sampleCases =
    input.problem.sampleCases.length === 0
      ? "No parsed sample cases were available."
      : JSON.stringify(input.problem.sampleCases, null, 2);
  const previousFeedback =
    input.attempt <= 1
      ? "No previous verifier feedback."
      : "This is a retry after previous verification feedback. Focus on whether the current code fixes the earlier issues and fully matches the screenshots.";

  return `
Attempt: ${input.attempt}
Target language: ${input.candidate.language}

Problem title:
${input.problem.title}

Reconstructed statement:
${input.problem.statement}

Parsed sample cases:
${sampleCases}

Candidate code:
${input.candidate.code}

Context:
${previousFeedback}

Decide whether this code is correct for the coding problem shown in the attached images.
  `.trim();
}
