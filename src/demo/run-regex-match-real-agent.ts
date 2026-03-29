import { DeepAgentCodeGenerationAgent } from "../agents/deep-code-generation-agent.js";
import { SupervisorAgent } from "../agents/supervisor-agent.js";
import type {
  CodeTestingAgent,
  ExecutedCase,
  GenerationFeedback,
  TestSolutionInput,
  TestingReport,
} from "../contracts/agents.js";
import type { CodingProblem } from "../contracts/problem.js";
import { InMemoryAgentTransport } from "../services/agent-transport.js";
import { BunTypeScriptExecutor } from "../services/execution/bun-executor.js";
import { createOpenAIChatModel } from "../services/llm/openai-chat-model.js";
import type { Logger } from "../utils/logger.js";
import { ConsoleLogger } from "../utils/logger.js";

interface RegexCase {
  name: string;
  s: string;
  p: string;
  expected: boolean;
  source: "sample" | "hidden";
}

class RegexFunctionTestingAgent implements CodeTestingAgent {
  readonly role = "code-tester" as const;
  private readonly logger: Logger;
  private readonly executor = new BunTypeScriptExecutor();

  constructor(logger: Logger) {
    this.logger = logger.child("regex-tester");
  }

  async test(input: TestSolutionInput): Promise<TestingReport> {
    this.logger.info("testing-started", { attempt: input.attempt });

    const executedCases: ExecutedCase[] = [];
    for (const testCase of getRegexCases()) {
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
        input: JSON.stringify({ s: testCase.s, p: testCase.p }),
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

export async function runRegexMatchRealAgent(): Promise<void> {
  const logger = new ConsoleLogger("regex-real-agent");
  const model = createOpenAIChatModel({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: 0,
  });

  const supervisor = new SupervisorAgent({
    generator: new DeepAgentCodeGenerationAgent(model, logger),
    tester: new RegexFunctionTestingAgent(logger),
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  const result = await supervisor.solve({
    problem: buildRegexProblem(),
    maxAttempts: 4,
  });

  if (result.status !== "passed" || !result.finalCandidate) {
    throw new Error(result.finalReport.verdict);
  }

  console.log(result.finalCandidate.code);
}

function buildRegexProblem(): CodingProblem {
  const statement = `
Regular Expression Matching

Implement a TypeScript function:
function isMatch(s: string, p: string): boolean

Given an input string s and a pattern p, implement regular expression matching with support for '.' and '*' where:
- '.' matches any single character.
- '*' matches zero or more of the preceding element.

Return a boolean indicating whether the matching covers the entire input string.

Important requirements:
- Return only the TypeScript function implementation.
- Do not read from stdin or write to stdout.
- The function must be named isMatch.
- The match must cover the whole string.

Constraints:
- 1 <= s.length <= 20
- 1 <= p.length <= 20
- s contains only lowercase English letters.
- p contains only lowercase English letters, '.', and '*'.
- For each '*', there is always a previous valid character to match.
  `.trim();

  return {
    id: crypto.randomUUID(),
    title: "Regular Expression Matching",
    rawText: statement,
    statement,
    targetLanguage: "typescript",
    sampleCases: [
      {
        name: "sample-1",
        input: JSON.stringify({ s: "aa", p: "a" }),
        expectedOutput: JSON.stringify(false),
        source: "sample",
      },
      {
        name: "sample-2",
        input: JSON.stringify({ s: "aa", p: "a*" }),
        expectedOutput: JSON.stringify(true),
        source: "sample",
      },
      {
        name: "sample-3",
        input: JSON.stringify({ s: "ab", p: ".*" }),
        expectedOutput: JSON.stringify(true),
        source: "sample",
      },
    ],
    verificationCases: [],
    constraints: [],
  };
}

function getRegexCases(): RegexCase[] {
  return [
    { name: "sample-1", s: "aa", p: "a", expected: false, source: "sample" },
    { name: "sample-2", s: "aa", p: "a*", expected: true, source: "sample" },
    { name: "sample-3", s: "ab", p: ".*", expected: true, source: "sample" },
    { name: "hidden-1", s: "aab", p: "c*a*b", expected: true, source: "hidden" },
    { name: "hidden-2", s: "mississippi", p: "mis*is*p*.", expected: false, source: "hidden" },
    { name: "hidden-3", s: "ab", p: ".*c", expected: false, source: "hidden" },
    { name: "hidden-4", s: "aaa", p: "a*a", expected: true, source: "hidden" },
    { name: "hidden-5", s: "aaa", p: "ab*a*c*a", expected: true, source: "hidden" },
    { name: "hidden-6", s: "a", p: "ab*", expected: true, source: "hidden" },
    { name: "hidden-7", s: "bbbba", p: ".*a*a", expected: true, source: "hidden" },
  ];
}

function buildHarness(candidateCode: string, testCase: RegexCase): string {
  return `
${candidateCode}

const testCase = ${JSON.stringify(testCase)};

if (typeof isMatch !== "function") {
  throw new Error("Expected a function named isMatch.");
}

const actual = isMatch(testCase.s, testCase.p);
const passed = actual === testCase.expected;

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
    summary: "The generated isMatch function failed semantic verification.",
    rootCause:
      failures[0]?.runtimeError ??
      "The regex matching logic is incorrect for one or more cases.",
    actionItems: [
      "Return a function named isMatch with signature (s, p) => boolean.",
      "The match must cover the entire string, not a partial substring.",
      "Handle '*' as zero or more of the immediately preceding element.",
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
  await runRegexMatchRealAgent();
}
