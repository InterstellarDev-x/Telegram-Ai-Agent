import type {
  CodeGenerationAgent,
  CodeTestingAgent,
  GenerateSolutionInput,
  SupervisorRunResult,
} from "../contracts/agents.ts";
import { supervisorRunResultSchema } from "../contracts/agents.ts";
import type { SolveProblemRequest } from "../contracts/problem.ts";
import { InMemoryAgentTransport } from "../services/agent-transport.ts";
import type { Logger } from "../utils/logger.ts";

interface SupervisorAgentOptions {
  generator: CodeGenerationAgent;
  tester: CodeTestingAgent;
  transport: InMemoryAgentTransport;
  logger: Logger;
}

export class SupervisorAgent {
  private readonly logger: Logger;

  constructor(private readonly options: SupervisorAgentOptions) {
    this.logger = options.logger.child("supervisor");
  }

  async solve(request: SolveProblemRequest): Promise<SupervisorRunResult> {
    const correlationId = crypto.randomUUID();
    const feedbackHistory: GenerateSolutionInput["feedbackHistory"] = [];
    let finalCandidate = undefined;
    let finalReport = undefined;

    this.logger.info("workflow-started", {
      problemId: request.problem.id,
      maxAttempts: request.maxAttempts,
    });

    for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
      this.options.transport.send(
        "supervisor",
        "code-generator",
        "generation.request",
        {
          attempt,
          feedbackHistory,
          problemId: request.problem.id,
        },
        correlationId,
      );

      const candidate = await this.options.generator.generate({
        problem: request.problem,
        attempt,
        feedbackHistory,
      });

      finalCandidate = candidate;

      this.options.transport.send(
        "code-generator",
        "supervisor",
        "generation.response",
        {
          attempt,
          language: candidate.language,
          strategy: candidate.strategy,
        },
        correlationId,
      );

      this.options.transport.send(
        "supervisor",
        "code-tester",
        "testing.request",
        {
          attempt,
          language: candidate.language,
        },
        correlationId,
      );

      const report = await this.options.tester.test({
        problem: request.problem,
        attempt,
        candidate,
      });

      finalReport = report;

      this.options.transport.send(
        "code-tester",
        "supervisor",
        "testing.response",
        {
          attempt,
          status: report.status,
          verdict: report.verdict,
        },
        correlationId,
      );

      if (report.status === "passed") {
        this.logger.info("workflow-passed", {
          attempt,
          problemId: request.problem.id,
        });

        return supervisorRunResultSchema.parse({
          status: "passed",
          attemptsUsed: attempt,
          problem: request.problem,
          finalCandidate: candidate,
          finalReport: report,
          transcript: this.options.transport.list(correlationId),
        });
      }

      if (report.feedback) {
        feedbackHistory.push(report.feedback);
      }
    }

    this.logger.warn("workflow-failed", {
      problemId: request.problem.id,
      attemptsUsed: request.maxAttempts,
    });

    return supervisorRunResultSchema.parse({
      status: "failed",
      attemptsUsed: request.maxAttempts,
      problem: request.problem,
      finalCandidate,
      finalReport:
        finalReport ??
        (() => {
          throw new Error("Supervisor finished without a testing report.");
        })(),
      transcript: this.options.transport.list(correlationId),
    });
  }
}
