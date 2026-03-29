import type {
  CodeGenerationAgent,
  GenerationFeedback,
  CodeTestingAgent,
  GenerateSolutionInput,
  SolutionCandidate,
  SupervisorRunResult,
} from "../contracts/agents.js";
import { supervisorRunResultSchema } from "../contracts/agents.js";
import type { SolveProblemRequest } from "../contracts/problem.js";
import { InMemoryAgentTransport } from "../services/agent-transport.js";
import type { Logger } from "../utils/logger.js";

interface SupervisorAgentOptions {
  generator: CodeGenerationAgent;
  tester: CodeTestingAgent;
  transport: InMemoryAgentTransport;
  logger: Logger;
}

interface SupervisorSolveSeed {
  feedbackHistory?: GenerationFeedback[];
  previousCandidates?: SolutionCandidate[];
}

export class SupervisorAgent {
  private readonly logger: Logger;

  constructor(private readonly options: SupervisorAgentOptions) {
    this.logger = options.logger.child("supervisor");
  }

  async solve(
    request: SolveProblemRequest,
    seed: SupervisorSolveSeed = {},
  ): Promise<SupervisorRunResult> {
    const correlationId = crypto.randomUUID();
    const feedbackHistory: GenerateSolutionInput["feedbackHistory"] = [
      ...(seed.feedbackHistory ?? []),
    ];
    const previousCandidates: GenerateSolutionInput["previousCandidates"] = [
      ...(seed.previousCandidates ?? []),
    ];
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

      const generationInput = {
        problem: request.problem,
        attempt,
        feedbackHistory,
        previousCandidates,
      };

      const candidates = this.options.generator.generateCandidates
        ? await this.options.generator.generateCandidates(generationInput)
        : [await this.options.generator.generate(generationInput)];

      for (const [candidateIndex, candidate] of candidates.entries()) {
        finalCandidate = candidate;
        previousCandidates.push(candidate);

        this.options.transport.send(
          "code-generator",
          "supervisor",
          "generation.response",
          {
            attempt,
            candidateIndex: candidateIndex + 1,
            language: candidate.language,
            provider: candidate.provider,
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
            candidateIndex: candidateIndex + 1,
            language: candidate.language,
            provider: candidate.provider,
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
            candidateIndex: candidateIndex + 1,
            provider: candidate.provider,
            status: report.status,
            verdict: report.verdict,
          },
          correlationId,
        );

        if (report.status === "passed") {
          this.logger.info("workflow-passed", {
            attempt,
            problemId: request.problem.id,
            provider: candidate.provider,
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
