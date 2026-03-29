import { DeepAgentCodeTestingAgent } from "../agents/deep-code-testing-agent.js";
import { ScriptedCodeGenerationAgent } from "../agents/scripted-code-generation-agent.js";
import { SupervisorAgent } from "../agents/supervisor-agent.js";
import type { SolutionCandidate } from "../contracts/agents.js";
import { InMemoryAgentTransport } from "../services/agent-transport.js";
import { BunJavaScriptExecutor, BunTypeScriptExecutor } from "../services/execution/bun-executor.js";
import { ExecutorRegistry } from "../services/execution/executor-registry.js";
import { PythonExecutor } from "../services/execution/python-executor.js";
import { ConsoleLogger } from "../utils/logger.js";
import { createDemoProblem } from "./problem-fixtures.js";

function createScriptedAttempts(): SolutionCandidate[] {
  return [
    {
      language: "javascript",
      strategy: "Read two integers and print Math.abs(a + b).",
      complexity: "O(1) time, O(1) space.",
      assumptions: ["Input always contains exactly two integers."],
      code: `
const input = await Bun.stdin.text();
const [a, b] = input.trim().split(/\\s+/).map(Number);
console.log(Math.abs(a + b));
      `.trim(),
    },
    {
      language: "javascript",
      strategy: "Read two integers and print their arithmetic sum.",
      complexity: "O(1) time, O(1) space.",
      assumptions: ["Input always contains exactly two integers."],
      code: `
const input = await Bun.stdin.text();
const [a, b] = input.trim().split(/\\s+/).map(Number);
console.log(a + b);
      `.trim(),
    },
  ];
}

export async function runExampleFlow(): Promise<void> {
  const logger = new ConsoleLogger("solver-demo");
  const executorRegistry = new ExecutorRegistry([
    new BunJavaScriptExecutor(),
    new BunTypeScriptExecutor(),
    new PythonExecutor(),
  ]);
  const generator = new ScriptedCodeGenerationAgent(
    createScriptedAttempts(),
    logger,
  );
  const tester = new DeepAgentCodeTestingAgent({
    executorRegistry,
    logger,
    useModelPlanning: false,
    useModelFeedback: false,
  });
  const supervisor = new SupervisorAgent({
    generator,
    tester,
    transport: new InMemoryAgentTransport(logger.child("transport")),
    logger,
  });

  const result = await supervisor.solve({
    problem: createDemoProblem(),
    maxAttempts: 3,
  });

  console.log("\nExample Flow");
  console.log(`status: ${result.status}`);
  console.log(`attempts: ${result.attemptsUsed}`);
  console.log("transcript:");
  for (const envelope of result.transcript) {
    console.log(`- ${envelope.from} -> ${envelope.to}: ${envelope.type}`);
  }

  if (result.status !== "passed" || !result.finalCandidate) {
    throw new Error("Example flow did not converge to a verified solution.");
  }

  console.log("\nVerified Code\n");
  console.log(result.finalCandidate.code);
}
