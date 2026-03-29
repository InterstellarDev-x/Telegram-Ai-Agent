import { describe, expect, test } from "bun:test";
import { DeepAgentCodeTestingAgent } from "../src/agents/deep-code-testing-agent.ts";
import { ScriptedCodeGenerationAgent } from "../src/agents/scripted-code-generation-agent.ts";
import { SupervisorAgent } from "../src/agents/supervisor-agent.ts";
import type { SolutionCandidate } from "../src/contracts/agents.ts";
import { InMemoryAgentTransport } from "../src/services/agent-transport.ts";
import {
  BunJavaScriptExecutor,
  BunTypeScriptExecutor,
} from "../src/services/execution/bun-executor.ts";
import { ExecutorRegistry } from "../src/services/execution/executor-registry.ts";
import { PythonExecutor } from "../src/services/execution/python-executor.ts";
import { MemoryLogger } from "../src/utils/logger.ts";
import { createDemoProblem } from "../src/demo/problem-fixtures.ts";

function buildAttempts(): SolutionCandidate[] {
  return [
    {
      language: "javascript",
      strategy: "Buggy absolute-sum implementation.",
      complexity: "O(1) time, O(1) space.",
      assumptions: [],
      code: `
const input = await Bun.stdin.text();
const [a, b] = input.trim().split(/\\s+/).map(Number);
console.log(Math.abs(a + b));
      `.trim(),
    },
    {
      language: "javascript",
      strategy: "Correct sum implementation.",
      complexity: "O(1) time, O(1) space.",
      assumptions: [],
      code: `
const input = await Bun.stdin.text();
const [a, b] = input.trim().split(/\\s+/).map(Number);
console.log(a + b);
      `.trim(),
    },
  ];
}

describe("SupervisorAgent", () => {
  test("retries until the verifier accepts the solution", async () => {
    const logger = new MemoryLogger("test");
    const supervisor = new SupervisorAgent({
      generator: new ScriptedCodeGenerationAgent(buildAttempts(), logger),
      tester: new DeepAgentCodeTestingAgent({
        executorRegistry: new ExecutorRegistry([
          new BunJavaScriptExecutor(),
          new BunTypeScriptExecutor(),
          new PythonExecutor(),
        ]),
        logger,
        useModelPlanning: false,
        useModelFeedback: false,
      }),
      transport: new InMemoryAgentTransport(logger.child("transport")),
      logger,
    });

    const result = await supervisor.solve({
      problem: createDemoProblem(),
      maxAttempts: 3,
    });

    expect(result.status).toBe("passed");
    expect(result.attemptsUsed).toBe(2);
    expect(result.finalCandidate?.code).toContain("a + b");
    expect(
      result.transcript.some(
        (message) =>
          message.type === "testing.response" &&
          (message.payload as { status: string }).status === "failed",
      ),
    ).toBeTrue();
    expect(
      result.transcript.some(
        (message) =>
          message.type === "testing.response" &&
          (message.payload as { status: string }).status === "passed",
      ),
    ).toBeTrue();
  });
});
