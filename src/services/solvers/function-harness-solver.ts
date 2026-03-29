import { DeepAgentCodeGenerationAgent } from "../../agents/deep-code-generation-agent.ts";
import { SupervisorAgent } from "../../agents/supervisor-agent.ts";
import type {
  CodeTestingAgent,
  ExecutedCase,
  GenerationFeedback,
  TestSolutionInput,
  TestingReport,
} from "../../contracts/agents.ts";
import type {
  FunctionHarness,
  StreamedSolveRequest,
  StreamedTestCase,
} from "../../contracts/http.ts";
import { buildProblemFromHttpRequest } from "../../contracts/http.ts";
import { InMemoryAgentTransport } from "../agent-transport.ts";
import { BunJavaScriptExecutor, BunTypeScriptExecutor } from "../execution/bun-executor.ts";
import { ExecutorRegistry } from "../execution/executor-registry.ts";
import { PythonExecutor } from "../execution/python-executor.ts";
import { createOpenAIChatModel } from "../llm/openai-chat-model.ts";
import type { Logger } from "../../utils/logger.ts";

export class FunctionHarnessTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;

  constructor(
    private readonly harness: FunctionHarness,
    private readonly logger: Logger,
    private readonly executorRegistry: ExecutorRegistry,
  ) {}

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", {
      attempt: input.attempt,
      language: input.candidate.language,
    });

    const executor = this.executorRegistry.get(input.candidate.language);
    const executedCases: ExecutedCase[] = [];

    for (const testCase of this.harness.tests) {
      const execution = await executor.execute(
        buildHarnessSource(input.candidate.code, this.harness, testCase),
        "",
        5_000,
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
        input: JSON.stringify(testCase.input),
        expectedOutput: JSON.stringify(testCase.expected),
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
      this.logger.info("testing-passed", {
        attempt: input.attempt,
        cases: executedCases.length,
      });

      return {
        status: "passed",
        verdict: `Validated on ${executedCases.length} harness case(s).`,
        executedCases,
      };
    }

    const feedback = buildFeedback(this.harness, failures);
    this.logger.warn("testing-failed", {
      attempt: input.attempt,
      failures: failures.length,
    });

    return {
      status: "failed",
      verdict: `Failed ${failures.length} of ${executedCases.length} harness case(s).`,
      executedCases,
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

  const executorRegistry = new ExecutorRegistry([
    new BunJavaScriptExecutor(),
    new BunTypeScriptExecutor(),
    new PythonExecutor(),
  ]);

  const supervisor = new SupervisorAgent({
    generator: new DeepAgentCodeGenerationAgent(model, logger),
    tester: new FunctionHarnessTestingAgent(
      request.harness,
      logger.child("function-harness-tester"),
      executorRegistry,
    ),
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  return await supervisor.solve({
    problem: buildProblemFromHttpRequest(request),
    maxAttempts: request.maxAttempts,
  });
}

function buildHarnessSource(
  candidateCode: string,
  harness: FunctionHarness,
  testCase: StreamedTestCase,
): string {
  return `
${candidateCode}

${harness.prelude}

const testCase = ${JSON.stringify(testCase)};

if (typeof ${harness.functionName} !== "function") {
  throw new Error("Expected a function named ${harness.functionName}.");
}

const actual = ${harness.invokeExpression};
const passed = (() => ${harness.assertionExpression})();

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

function buildFeedback(
  harness: FunctionHarness,
  failures: ExecutedCase[],
): GenerationFeedback {
  return {
    summary: `The generated ${harness.functionName} function failed harness verification.`,
    rootCause:
      failures[0]?.runtimeError ??
      "The generated function does not satisfy the provided assertion expression.",
    actionItems: [
      `Return a function named ${harness.functionName}.`,
      "Return only the function implementation, not a full program.",
      "Fix the logic using the failing harness cases.",
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
