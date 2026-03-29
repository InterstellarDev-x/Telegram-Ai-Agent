import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { providerStrategy } from "langchain";
import {
  generationFeedbackSchema,
  testingPlanSchema,
  testingReportSchema,
  type CodeTestingAgent,
  type ExecutedCase,
  type GenerationFeedback,
  type TestSolutionInput,
  type TestingPlan,
  type TestingReport,
} from "../contracts/agents.js";
import type { ProblemTestCase } from "../contracts/problem.js";
import { ExecutorRegistry } from "../services/execution/executor-registry.js";
import { normalizeOutput } from "../utils/output.js";
import type { Logger } from "../utils/logger.js";

const TEST_PLAN_PROMPT = `
You are the Code Testing Agent.

You must validate candidate code conservatively.

Rules:
- Always include all known sample tests.
- Add extra edge cases only when the expected output is unambiguous.
- Keep the test suite small and high signal.
- Do not invent ambiguous expected outputs.
`;

const FEEDBACK_PROMPT = `
You are the Code Testing Agent.

The candidate failed verification.
Produce precise feedback for the Code Generation Agent.
Focus on the smallest set of changes needed to pass the failing cases.
`;

interface DeepAgentCodeTestingAgentOptions {
  model?: BaseLanguageModel;
  executorRegistry: ExecutorRegistry;
  logger: Logger;
  executionTimeoutMs?: number;
  useModelPlanning?: boolean;
  useModelFeedback?: boolean;
}

export class DeepAgentCodeTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;
  private readonly logger: Logger;
  private readonly model?: BaseLanguageModel;
  private readonly executorRegistry: ExecutorRegistry;
  private readonly executionTimeoutMs: number;
  private readonly useModelPlanning: boolean;
  private readonly useModelFeedback: boolean;
  private planAgentPromise?: Promise<StructuredAgent>;
  private feedbackAgentPromise?: Promise<StructuredAgent>;

  constructor(options: DeepAgentCodeTestingAgentOptions) {
    this.logger = options.logger.child("code-tester");
    this.model = options.model;
    this.executorRegistry = options.executorRegistry;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 2_500;
    this.useModelPlanning = options.useModelPlanning ?? Boolean(options.model);
    this.useModelFeedback = options.useModelFeedback ?? Boolean(options.model);
  }

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", {
      attempt: input.attempt,
      language: input.candidate.language,
    });

    const plan = await this.createPlan(input);
    const executedCases = await this.executePlan(input, plan);
    const failures = executedCases.filter((testCase) => !testCase.passed);

    if (failures.length === 0) {
      const report = testingReportSchema.parse({
        status: "passed",
        verdict: `Validated on ${executedCases.length} test case(s).`,
        executedCases,
      });

      this.logger.info("testing-passed", {
        attempt: input.attempt,
        cases: executedCases.length,
      });

      return report;
    }

    const feedback = await this.createFeedback(input, failures);
    const report = testingReportSchema.parse({
      status: "failed",
      verdict: `Failed ${failures.length} of ${executedCases.length} test case(s).`,
      executedCases,
      feedback,
    });

    this.logger.warn("testing-failed", {
      attempt: input.attempt,
      failures: failures.length,
    });

    return report;
  }

  private async createPlan(input: TestSolutionInput): Promise<TestingPlan> {
    const baselineCases = dedupeCases([
      ...input.problem.sampleCases,
      ...input.problem.verificationCases,
    ]);

    if (!this.useModelPlanning || !this.model) {
      return {
        reasoning: "Using deterministic cases from the problem and internal verifier.",
        coverage: [
          "sample coverage",
          baselineCases.some((testCase) => testCase.source === "hidden")
            ? "hidden edge coverage"
            : "no hidden cases available",
        ],
        cases: baselineCases,
      };
    }

    try {
      const planAgent = await this.getPlanAgent();
      const result = await planAgent.invoke({
        messages: [
          {
            role: "user",
            content: `
Problem statement:
${input.problem.statement}

Known baseline tests:
${JSON.stringify(baselineCases, null, 2)}

Return a structured testing plan.
            `.trim(),
          },
        ],
      });

      const llmPlan = testingPlanSchema.parse(
        (result as { structuredResponse?: unknown }).structuredResponse,
      );
      return {
        ...llmPlan,
        cases: dedupeCases([...baselineCases, ...llmPlan.cases]),
      };
    } catch (error) {
      this.logger.warn("testing-plan-fallback", {
        reason: error instanceof Error ? error.message : "unknown error",
      });

      return {
        reasoning: "Model planning failed, falling back to deterministic cases.",
        coverage: ["sample coverage fallback"],
        cases: baselineCases,
      };
    }
  }

  private async executePlan(
    input: TestSolutionInput,
    plan: TestingPlan,
  ): Promise<ExecutedCase[]> {
    const executor = this.executorRegistry.get(input.candidate.language);
    const executedCases: ExecutedCase[] = [];

    for (const testCase of plan.cases) {
      const execution = await executor.execute(
        input.candidate.code,
        appendTrailingNewline(testCase.input),
        this.executionTimeoutMs,
      );

      const actualOutput = normalizeOutput(execution.stdout);
      const expectedOutput = normalizeOutput(testCase.expectedOutput);
      const runtimeError = execution.timedOut
        ? "Execution timed out."
        : normalizeOutput(execution.stderr);
      const passed =
        execution.exitCode === 0 &&
        !execution.timedOut &&
        actualOutput === expectedOutput;

      executedCases.push({
        name: testCase.name,
        source: testCase.source,
        input: testCase.input,
        expectedOutput: testCase.expectedOutput,
        actualOutput,
        passed,
        runtimeError: runtimeError || undefined,
        durationMs: execution.durationMs,
      });
    }

    return executedCases;
  }

  private async createFeedback(
    input: TestSolutionInput,
    failures: ExecutedCase[],
  ): Promise<GenerationFeedback> {
    if (!this.useModelFeedback || !this.model) {
      return {
        summary: "The candidate failed verifier cases.",
        rootCause:
          failures[0]?.runtimeError ??
          "The program produces incorrect output for at least one case.",
        actionItems: [
          "Re-check the core algorithm against the failing cases.",
          "Preserve standard input/output formatting.",
        ],
        failingCases: failures.map((failure) => ({
          name: failure.name,
          input: failure.input,
          expectedOutput: failure.expectedOutput,
          actualOutput: failure.actualOutput,
          source: failure.source,
        })),
      };
    }

    try {
      const feedbackAgent = await this.getFeedbackAgent();
      const result = await feedbackAgent.invoke({
        messages: [
          {
            role: "user",
            content: `
Problem statement:
${input.problem.statement}

Candidate language:
${input.candidate.language}

Candidate code:
${input.candidate.code}

Failing executions:
${JSON.stringify(failures, null, 2)}

Return structured correction feedback.
            `.trim(),
          },
        ],
      });

      return generationFeedbackSchema.parse(
        (result as { structuredResponse?: unknown }).structuredResponse,
      );
    } catch (error) {
      this.logger.warn("testing-feedback-fallback", {
        reason: error instanceof Error ? error.message : "unknown error",
      });

      return {
        summary: "The candidate failed verifier cases.",
        rootCause:
          failures[0]?.runtimeError ??
          "The program produces incorrect output for at least one case.",
        actionItems: [
          "Fix the failing logic shown by the verifier cases.",
          "Keep the solution in standard input/output form.",
        ],
        failingCases: failures.map((failure) => ({
          name: failure.name,
          input: failure.input,
          expectedOutput: failure.expectedOutput,
          actualOutput: failure.actualOutput,
          source: failure.source,
        })),
      };
    }
  }

  private async getPlanAgent(): Promise<StructuredAgent> {
    if (!this.model) {
      throw new Error("Model-backed planning requires a configured model.");
    }

    this.planAgentPromise ??= createStructuredDeepAgent(
      this.model,
      TEST_PLAN_PROMPT,
      testingPlanSchema,
    );

    return await this.planAgentPromise;
  }

  private async getFeedbackAgent(): Promise<StructuredAgent> {
    if (!this.model) {
      throw new Error("Model-backed feedback requires a configured model.");
    }

    this.feedbackAgentPromise ??= createStructuredDeepAgent(
      this.model,
      FEEDBACK_PROMPT,
      generationFeedbackSchema,
    );

    return await this.feedbackAgentPromise;
  }
}

function dedupeCases(cases: ProblemTestCase[]): ProblemTestCase[] {
  const seen = new Set<string>();
  const deduped: ProblemTestCase[] = [];

  for (const testCase of cases) {
    const key = `${testCase.input}:::${testCase.expectedOutput}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(testCase);
  }

  return deduped;
}

function appendTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

type StructuredAgent = {
  invoke(input: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ structuredResponse?: unknown }>;
};

async function createStructuredDeepAgent(
  model: BaseLanguageModel,
  systemPrompt: string,
  schema:
    | typeof testingPlanSchema
    | typeof generationFeedbackSchema,
): Promise<StructuredAgent> {
  const { createDeepAgent } = await import("deepagents");

  return createDeepAgent({
    model,
    systemPrompt,
    responseFormat: providerStrategy(schema),
  }) as StructuredAgent;
}
