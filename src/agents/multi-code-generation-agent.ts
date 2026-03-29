import type {
  CodeGenerationAgent,
  GenerateSolutionInput,
  SolutionCandidate,
} from "../contracts/agents.js";
import type { Logger } from "../utils/logger.js";

export class MultiCodeGenerationAgent implements CodeGenerationAgent {
  readonly role = "code-generator" as const;

  constructor(
    private readonly generators: CodeGenerationAgent[],
    private readonly logger: Logger,
  ) {}

  async generate(input: GenerateSolutionInput): Promise<SolutionCandidate> {
    const candidates = await this.generateCandidates(input);
    const first = candidates[0];

    if (!first) {
      throw new Error("No code generators produced a candidate.");
    }

    return first;
  }

  async generateCandidates(
    input: GenerateSolutionInput,
  ): Promise<SolutionCandidate[]> {
    const settled = await Promise.allSettled(
      this.generators.map(async (generator) => await generator.generate(input)),
    );

    const candidates: SolutionCandidate[] = [];
    const failures: string[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        candidates.push(result.value);
      } else {
        failures.push(
          result.reason instanceof Error
            ? result.reason.message
            : "unknown generator error",
        );
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        `All code generators failed: ${failures.join(" | ") || "unknown error"}`,
      );
    }

    if (failures.length > 0) {
      this.logger.warn("multi-generator-partial-failure", {
        failures,
        produced: candidates.map((candidate) => candidate.provider ?? "unknown"),
      });
    }

    return candidates;
  }
}
