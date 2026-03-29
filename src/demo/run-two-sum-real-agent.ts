import { SupervisorAgent } from "../agents/supervisor-agent.js";
import type {
  CodeGenerationAgent,
  CodeTestingAgent,
  ExecutedCase,
  GenerateSolutionInput,
  GenerationFeedback,
  SolutionCandidate,
  TestSolutionInput,
  TestingReport,
} from "../contracts/agents.js";
import { solutionCandidateSchema } from "../contracts/agents.js";
import type { CodingProblem } from "../contracts/problem.js";
import { InMemoryAgentTransport } from "../services/agent-transport.js";
import { BunTypeScriptExecutor } from "../services/execution/bun-executor.js";
import { createOpenAIChatModel } from "../services/llm/openai-chat-model.js";
import type { Logger } from "../utils/logger.js";
import { ConsoleLogger } from "../utils/logger.js";

interface TwoSumCase {
  name: string;
  nums: number[];
  target: number;
  validPairs: Array<[number, number]>;
  source: "sample" | "hidden";
}

class TwoSumFunctionTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;
  private readonly logger;
  private readonly executor = new BunTypeScriptExecutor();

  constructor(logger: ConsoleLogger) {
    this.logger = logger.child("two-sum-tester");
  }

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", { attempt: input.attempt });

    const cases = getTwoSumCases();
    const executedCases: ExecutedCase[] = [];

    for (const testCase of cases) {
      const execution = await this.executor.execute(
        buildHarness(input.candidate.code, testCase),
        "",
        4_000,
      );

      const parsed = parseHarnessResult(execution.stdout);
      const passed =
        execution.exitCode === 0 &&
        !execution.timedOut &&
        parsed.ok &&
        parsed.passed;

      executedCases.push({
        name: testCase.name,
        source: testCase.source,
        input: JSON.stringify({
          nums: testCase.nums,
          target: testCase.target,
        }),
        expectedOutput: JSON.stringify(testCase.validPairs),
        actualOutput: parsed.output,
        passed,
        runtimeError:
          execution.timedOut
            ? "Execution timed out."
            : execution.stderr.trim() || parsed.error,
        durationMs: execution.durationMs,
      });
    }

    const failures = executedCases.filter((testCase) => !testCase.passed);

    if (failures.length === 0) {
      return {
        status: "passed",
        verdict: `Validated on ${executedCases.length} semantic test case(s).`,
        executedCases,
      };
    }

    return {
      status: "failed",
      verdict: `Failed ${failures.length} of ${executedCases.length} semantic test case(s).`,
      executedCases,
      feedback: buildFeedback(failures),
    };
  }
}

class OpenAIStructuredCodeGenerationAgent implements CodeGenerationAgent {
  readonly role = "code-generator" as const;
  private readonly logger: Logger;
  private readonly runnable;

  constructor(model: ReturnType<typeof createOpenAIChatModel>, logger: Logger) {
    this.logger = logger.child("openai-generator");
    this.runnable = model.withStructuredOutput(solutionCandidateSchema);
  }

  async generate(input: GenerateSolutionInput): Promise<SolutionCandidate> {
    this.logger.info("generation-started", {
      attempt: input.attempt,
      feedbackCount: input.feedbackHistory.length,
    });

    const feedback =
      input.feedbackHistory.length === 0
        ? "No prior tester feedback."
        : input.feedbackHistory
            .map(
              (item, index) => `Attempt ${index + 1}:
summary: ${item.summary}
rootCause: ${item.rootCause}
actionItems:
${item.actionItems.map((action) => `- ${action}`).join("\n")}`,
            )
            .join("\n\n");

    const result = await this.runnable.invoke(`
You are solving a LeetCode-style problem in TypeScript.

Return structured output with:
- language = "typescript"
- code = only the function implementation
- strategy
- complexity
- assumptions

The function must be named twoSum and have signature:
function twoSum(nums: number[], target: number): number[]

Do not use stdin/stdout. Do not include markdown fences.

Problem:
${input.problem.statement}

Sample cases:
${JSON.stringify(input.problem.sampleCases, null, 2)}

Tester feedback:
${feedback}
    `.trim());

    const candidate = solutionCandidateSchema.parse(result);

    this.logger.info("generation-finished", {
      attempt: input.attempt,
      language: candidate.language,
    });

    return candidate;
  }
}

export async function runTwoSumRealAgent(): Promise<void> {
  const logger = new ConsoleLogger("two-sum-real-agent");
  const model = createOpenAIChatModel({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: 0,
  });

  const supervisor = new SupervisorAgent({
    generator: new OpenAIStructuredCodeGenerationAgent(model, logger),
    tester: new TwoSumFunctionTestingAgent(logger),
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  const result = await supervisor.solve({
    problem: buildTwoSumProblem(),
    maxAttempts: 4,
  });

  if (result.status !== "passed" || !result.finalCandidate) {
    throw new Error(result.finalReport.verdict);
  }

  console.log(result.finalCandidate.code);
}

function buildTwoSumProblem(): CodingProblem {
  const statement = `
Two Sum

Implement a TypeScript function:
function twoSum(nums: number[], target: number): number[]

Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.

You may assume that each input has exactly one solution, and you may not use the same element twice.
You can return the answer in any order.

Important requirements:
- Return only the TypeScript function implementation.
- Do not read from stdin or write to stdout.
- The function must be named twoSum.
- Return indices, not values.

Example 1:
nums = [2,7,11,15], target = 9
Output: [0,1]

Example 2:
nums = [3,2,4], target = 6
Output: [1,2]

Example 3:
nums = [3,3], target = 6
Output: [0,1]
  `.trim();

  return {
    id: crypto.randomUUID(),
    title: "Two Sum",
    rawText: statement,
    statement,
    targetLanguage: "typescript",
    sampleCases: [
      {
        name: "sample-1",
        input: JSON.stringify({ nums: [2, 7, 11, 15], target: 9 }),
        expectedOutput: JSON.stringify([
          [0, 1],
          [1, 0],
        ]),
        source: "sample",
      },
      {
        name: "sample-2",
        input: JSON.stringify({ nums: [3, 2, 4], target: 6 }),
        expectedOutput: JSON.stringify([
          [1, 2],
          [2, 1],
        ]),
        source: "sample",
      },
      {
        name: "sample-3",
        input: JSON.stringify({ nums: [3, 3], target: 6 }),
        expectedOutput: JSON.stringify([
          [0, 1],
          [1, 0],
        ]),
        source: "sample",
      },
    ],
    verificationCases: [],
    constraints: [],
  };
}

function getTwoSumCases(): TwoSumCase[] {
  return [
    {
      name: "sample-1",
      nums: [2, 7, 11, 15],
      target: 9,
      validPairs: [
        [0, 1],
        [1, 0],
      ],
      source: "sample",
    },
    {
      name: "sample-2",
      nums: [3, 2, 4],
      target: 6,
      validPairs: [
        [1, 2],
        [2, 1],
      ],
      source: "sample",
    },
    {
      name: "sample-3",
      nums: [3, 3],
      target: 6,
      validPairs: [
        [0, 1],
        [1, 0],
      ],
      source: "sample",
    },
    {
      name: "hidden-zeros",
      nums: [0, 4, 3, 0],
      target: 0,
      validPairs: [
        [0, 3],
        [3, 0],
      ],
      source: "hidden",
    },
    {
      name: "hidden-negatives",
      nums: [-1, -2, -3, -4, -5],
      target: -8,
      validPairs: [
        [2, 4],
        [4, 2],
      ],
      source: "hidden",
    },
    {
      name: "hidden-duplicates",
      nums: [1, 5, 1, 5],
      target: 10,
      validPairs: [
        [1, 3],
        [3, 1],
      ],
      source: "hidden",
    },
  ];
}

function buildHarness(candidateCode: string, testCase: TwoSumCase): string {
  return `
${candidateCode}

const testCase = ${JSON.stringify(testCase)};

if (typeof twoSum !== "function") {
  throw new Error("Expected a function named twoSum.");
}

const actual = twoSum(testCase.nums, testCase.target);
const normalized = Array.isArray(actual) ? actual : null;
const passed =
  Array.isArray(normalized) &&
  normalized.length === 2 &&
  Number.isInteger(normalized[0]) &&
  Number.isInteger(normalized[1]) &&
  normalized[0] !== normalized[1] &&
  normalized[0] >= 0 &&
  normalized[1] >= 0 &&
  normalized[0] < testCase.nums.length &&
  normalized[1] < testCase.nums.length &&
  testCase.nums[normalized[0]] + testCase.nums[normalized[1]] === testCase.target;

console.log(JSON.stringify({ actual, passed }));
  `.trim();
}

function parseHarnessResult(stdout: string): {
  ok: boolean;
  passed: boolean;
  output: string;
  error?: string;
} {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return {
      ok: false,
      passed: false,
      output: "",
      error: "Harness did not produce JSON output.",
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      actual?: unknown;
      passed?: boolean;
    };

    return {
      ok: true,
      passed: parsed.passed === true,
      output: JSON.stringify(parsed.actual),
    };
  } catch {
    return {
      ok: false,
      passed: false,
      output: trimmed,
      error: "Harness output was not valid JSON.",
    };
  }
}

function buildFeedback(failures: ExecutedCase[]): GenerationFeedback {
  return {
    summary: "The generated twoSum function failed semantic verification.",
    rootCause:
      failures[0]?.runtimeError ??
      "The returned indices do not satisfy the required pair constraints.",
    actionItems: [
      "Return a function named twoSum with signature (nums, target) => number[].",
      "Return indices whose values sum to target, not the values themselves.",
      "Do not reuse the same element twice.",
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

if (import.meta.main) {
  await runTwoSumRealAgent();
}
