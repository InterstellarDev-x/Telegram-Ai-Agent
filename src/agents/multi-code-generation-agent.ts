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
    const activeGenerators = this.selectGenerators(input);
    const settled = await Promise.allSettled(
      activeGenerators.map(async (generator) => await generator.generate(input)),
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

    this.logger.info("generation-candidates-ready", {
      attempt: input.attempt,
      providers: candidates.map((candidate) => candidate.provider ?? "unknown"),
      count: candidates.length,
    });

    if (failures.length > 0) {
      this.logger.warn("multi-generator-partial-failure", {
        failures,
        produced: candidates.map((candidate) => candidate.provider ?? "unknown"),
      });
    }

    return candidates;
  }

  private selectGenerators(input: GenerateSolutionInput): CodeGenerationAgent[] {
    const selected = this.generators.filter((generator) => {
      if (generator.providerName !== "gemini") {
        return true;
      }

      return input.attempt > 1;
    });

    if (selected.length === 0) {
      return this.generators;
    }

    const skippedProviders = this.generators
      .filter((generator) => !selected.includes(generator))
      .map((generator) => generator.providerName ?? "unknown");
    if (skippedProviders.length > 0) {
      this.logger.info("generation-providers-skipped", {
        attempt: input.attempt,
        skipped: skippedProviders,
      });
    }

    return selected;
  }
}
