import type {
  CodeGenerationAgent,
  GenerateSolutionInput,
  SolutionCandidate,
} from "../contracts/agents.js";
import type { Logger } from "../utils/logger.js";

export class ScriptedCodeGenerationAgent implements CodeGenerationAgent {
  readonly role = "code-generator" as const;
  private readonly logger: Logger;
  private readonly attempts: SolutionCandidate[];
  private currentIndex = 0;

  constructor(attempts: SolutionCandidate[], logger: Logger) {
    if (attempts.length === 0) {
      throw new Error("ScriptedCodeGenerationAgent requires at least one attempt.");
    }

    this.attempts = attempts;
    this.logger = logger.child("scripted-generator");
  }

  async generate(_input: GenerateSolutionInput): Promise<SolutionCandidate> {
    const index = Math.min(this.currentIndex, this.attempts.length - 1);
    const candidate = this.attempts[index]!;

    this.currentIndex += 1;
    this.logger.info("scripted-generation", {
      emittedAttempt: index + 1,
      language: candidate.language,
    });

    return candidate;
  }
}
