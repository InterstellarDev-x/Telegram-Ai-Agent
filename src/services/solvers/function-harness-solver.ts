import { z } from "zod";
import { DeepAgentCodeGenerationAgent } from "../../agents/deep-code-generation-agent.js";
import { GeminiCodeGenerationAgent } from "../../agents/gemini-code-generation-agent.js";
import { MultiCodeGenerationAgent } from "../../agents/multi-code-generation-agent.js";
import { SupervisorAgent } from "../../agents/supervisor-agent.js";
import type {
  CodeGenerationAgent,
  CodeTestingAgent,
  GenerationFeedback,
  SolutionCandidate,
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
  verdict: z.string().default(""),
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

class ImageAwareCodeTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;

  constructor(private readonly logger: Logger) {}

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", {
      attempt: input.attempt,
      language: input.candidate.language,
      imageAssets: input.problem.imageAssets.length,
    });

    const deterministicGuardrailReport = runDeterministicVerificationGuards(input);
    if (deterministicGuardrailReport) {
      this.logger.warn("deterministic-verification-failed", {
        attempt: input.attempt,
        verdict: deterministicGuardrailReport.verdict,
      });
      return deterministicGuardrailReport;
    }

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
- These problems are typically exam-style stdin/stdout tasks and may include starter code, predefined functions, or class signatures in the screenshots.
- Some images may primarily show the boilerplate template or code editor rather than the statement text.
- When boilerplate is visible, verify that the candidate preserves the required interface and fits naturally into that template.
- These may be hard competitive-programming problems, so reject solutions whose algorithmic complexity is inconsistent with the visible constraints even if the sample cases look fine.
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

    const review = normalizeVerificationReview(
      llmVerificationSchema.parse(JSON.parse(response.output_text.trim())),
    );

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

function normalizeVerificationReview(
  review: z.infer<typeof llmVerificationSchema>,
): {
  passed: boolean;
  verdict: string;
  rootCause: string;
  actionItems: string[];
  failingCases: Array<{
    name: string;
    input: string;
    expectedOutput: string;
    actualOutput: string;
    source: string;
  }>;
} {
  const verdict = review.verdict.trim() || defaultVerdict(review.passed);
  const rootCause = review.rootCause.trim() || defaultRootCause(review.passed, verdict);
  const actionItems = review.actionItems
    .map((item) => item.trim())
    .filter(Boolean);
  const failingCases = review.failingCases.map((failure, index) => ({
    name: failure.name.trim() || `review-case-${index + 1}`,
    input: failure.input.trim(),
    expectedOutput: failure.expectedOutput.trim(),
    actualOutput: failure.actualOutput.trim(),
    source: failure.source.trim() || "review",
  }));

  return {
    passed: review.passed,
    verdict,
    rootCause,
    actionItems,
    failingCases,
  };
}

function defaultVerdict(passed: boolean): string {
  return passed
    ? "The code appears correct for the uploaded problem."
    : "The code could not be verified as correct for the uploaded problem.";
}

function defaultRootCause(passed: boolean, verdict: string): string {
  return passed ? verdict : "The verifier did not provide a concrete root cause.";
}

export async function solveWithFunctionHarness(
  request: StreamedSolveRequest,
  logger: Logger,
  seed: {
    feedbackHistory?: GenerationFeedback[];
    previousCandidates?: SolutionCandidate[];
  } = {},
): Promise<Awaited<ReturnType<SupervisorAgent["solve"]>>> {
  const model = createOpenAIChatModel({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: 0,
  });

  const generators: CodeGenerationAgent[] = [
    new DeepAgentCodeGenerationAgent(model, logger),
  ];
  if (process.env.GEMINI_API_KEY?.trim()) {
    generators.push(new GeminiCodeGenerationAgent(logger));
  }

  const supervisor = new SupervisorAgent({
    generator: new MultiCodeGenerationAgent(generators, logger.child("multi-generator")),
    tester: new ImageAwareCodeTestingAgent(logger.child("image-aware-tester")),
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  return await supervisor.solve({
    problem: buildProblemFromHttpRequest(request),
    maxAttempts: request.maxAttempts,
  }, seed);
}

export async function verifyCandidateWithFunctionHarness(
  request: StreamedSolveRequest,
  candidate: SolutionCandidate,
  logger: Logger,
): Promise<TestingReport> {
  const tester = new ImageAwareCodeTestingAgent(logger.child("image-aware-tester"));
  return await tester.test({
    problem: buildProblemFromHttpRequest(request),
    attempt: 1,
    candidate,
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
  const extractionWarnings =
    input.problem.extractionWarnings.length === 0
      ? "No extraction warnings."
      : input.problem.extractionWarnings.map((warning) => `- ${warning}`).join("\n");

  return `
Attempt: ${input.attempt}
Target language: ${input.candidate.language}

Problem title:
${input.problem.title}

Reconstructed statement:
${input.problem.statement}

Parsed sample cases:
${sampleCases}

Extraction warnings:
${extractionWarnings}

Candidate code:
${input.candidate.code}

Context:
${previousFeedback}

Decide whether this code is correct for the coding problem shown in the attached images.
If the screenshots include starter code, required function/class names, or sample tests, evaluate against those exact requirements.
Ignore website/editor chrome and focus only on the actual problem content and template code shown in the screenshots.
  `.trim();
}

function runDeterministicVerificationGuards(
  input: TestSolutionInput,
): TestingReport | null {
  const template = extractStarterTemplate(input.problem.statement);
  const complexityMismatch = detectComplexityMismatch(
    input.problem.statement,
    input.problem.constraints,
    input.candidate.complexity,
  );
  if (complexityMismatch) {
    return {
      status: "failed",
      verdict: complexityMismatch,
      executedCases: [],
      feedback: {
        summary: complexityMismatch,
        rootCause: complexityMismatch,
        actionItems: [
          "Choose an algorithm whose complexity matches the visible constraints.",
          "Explain the intended asymptotic complexity clearly and ensure the code implements that approach.",
        ],
        failingCases: [],
      },
    };
  }

  const interfaceMismatch = detectInterfaceMismatch(
    input.problem.statement,
    template,
    input.problem.targetLanguage,
    input.candidate.code,
  );
  if (interfaceMismatch) {
    return {
      status: "failed",
      verdict: interfaceMismatch,
      executedCases: [],
      feedback: {
        summary: interfaceMismatch,
        rootCause: interfaceMismatch,
        actionItems: [
          "Preserve the required interface or starter template visible in the statement or screenshots.",
          "For stdin/stdout problems in C++, provide a complete program with int main unless a template explicitly replaces it.",
        ],
        failingCases: [],
      },
    };
  }

  return null;
}

function detectComplexityMismatch(
  statement: string,
  constraints: string[],
  complexity: string,
): string | null {
  const source = `${statement}\n${constraints.join("\n")}`;
  const maxMagnitude = extractMaxConstraintMagnitude(source);
  const normalizedComplexity = complexity.toLowerCase();

  if (
    maxMagnitude >= 100_000 &&
    /(quadratic|o\s*\(\s*n\s*\^\s*2\s*\)|o\s*\(\s*n\s*\*\s*n\s*\)|n\^2)/i.test(
      normalizedComplexity,
    )
  ) {
    return "The claimed algorithmic complexity looks too slow for the visible constraints.";
  }

  if (
    maxMagnitude >= 1_000 &&
    /(exponential|2\^n|o\s*\(\s*2\^n\s*\)|factorial)/i.test(
      normalizedComplexity,
    )
  ) {
    return "The claimed complexity is exponential and does not fit the visible constraints.";
  }

  return null;
}

function detectInterfaceMismatch(
  statement: string,
  template: string,
  targetLanguage: string,
  code: string,
): string | null {
  const requiredClassNames = Array.from(
    template.matchAll(/\bclass\s+([A-Za-z_]\w*)/g),
    (match) => match[1],
  );
  for (const className of requiredClassNames) {
    if (!new RegExp(`\\bclass\\s+${className}\\b`).test(code)) {
      return `The candidate does not preserve the required class ${className}.`;
    }
  }

  const requiredFunctionNames = Array.from(
    template.matchAll(
      /\b(?:int|long long|double|bool|string|void|vector<[^>]+>|map<[^>]+>|set<[^>]+>|unordered_map<[^>]+>|unordered_set<[^>]+>|auto)\s+([A-Za-z_]\w*)\s*\(/g,
    ),
    (match) => match[1],
  ).filter((name) => name !== "main");

  for (const functionName of requiredFunctionNames) {
    if (!new RegExp(`\\b${functionName}\\s*\\(`).test(code)) {
      return `The candidate does not preserve the required function ${functionName}.`;
    }
  }

  const looksLikeStdinStdout = /input format|sample test cases|output format|output:/i.test(
    statement,
  );
  if (
    targetLanguage === "cpp" &&
    looksLikeStdinStdout &&
    !template &&
    !/\bint\s+main\s*\(/.test(code)
  ) {
    return "The candidate does not provide a complete C++ stdin/stdout program with int main.";
  }

  return null;
}

function extractStarterTemplate(statement: string): string {
  const marker = "\nStarter Template:\n";
  const markerIndex = statement.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }

  return statement.slice(markerIndex + marker.length).trim();
}

function extractMaxConstraintMagnitude(source: string): number {
  let max = 0;

  for (const match of source.matchAll(/\b10\^(\d+)\b/g)) {
    const exponent = Number(match[1]);
    if (Number.isFinite(exponent)) {
      max = Math.max(max, 10 ** Math.min(exponent, 12));
    }
  }

  for (const match of source.matchAll(/\b\d[\d,]*\b/g)) {
    const parsed = Number(match[0].replaceAll(",", ""));
    if (Number.isFinite(parsed)) {
      max = Math.max(max, parsed);
    }
  }

  return max;
}
