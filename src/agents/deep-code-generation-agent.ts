import type { PooledChatModel } from "../services/llm/key-pool/pooled-chat-model.js";
import {
  solutionCandidateSchema,
  type CodeGenerationAgent,
  type GenerateSolutionInput,
  type SolutionCandidate,
} from "../contracts/agents.js";
import type { Logger } from "../utils/logger.js";
import {
  compactProblemStatement,
  estimatePromptChars,
  formatFeedbackHistory,
  formatPreviousCandidates,
  formatSampleCases,
  formatWarnings,
} from "../utils/prompt-compaction.js";

const modelSolutionCandidateSchema = solutionCandidateSchema.omit({
  provider: true,
});

const CODE_GENERATION_SYSTEM_PROMPT = `
You are the Code Generation Agent in a coding-problem solving backend.

Your job:
- Generate a correct solution for the given exam-style competitive programming problem.
- Return only one implementation in the requested language.
- If the requested language is cpp, produce a complete C++17 solution by default.
- Prefer stdin/stdout solutions unless the problem explicitly requires a particular class, function, or starter-code shape.
- If the screenshots or statement contain starter code or a predefined signature, preserve that interface exactly.
- The screenshots may include separate boilerplate/template images. If a template is present, complete that template instead of rewriting the interface from scratch.
- Prefer straightforward, reliable code over cleverness.
- Pay close attention to constraints and choose an algorithm that fits them.
- Assume the problem may be hard or very hard competitive programming. Optimize for correctness under worst-case constraints, not just sample cases.
- Explicitly reason about time complexity, memory complexity, corner cases, indexing, overflow, and proof of correctness before settling on an approach.
- If a naive or quadratic approach would fail the stated constraints, do not use it.
- Use all provided sample tests and explanations as consistency checks, but do not hardcode sample outputs.
- If feedback from previous failed attempts exists, directly address it.
- Do not include markdown fences.
`;

export class DeepAgentCodeGenerationAgent implements CodeGenerationAgent {
  readonly role = "code-generator" as const;
  readonly providerName = "openai" as const;
  private readonly logger: Logger;
  private readonly model: PooledChatModel;

  constructor(model: PooledChatModel, logger: Logger) {
    this.model = model;
    this.logger = logger.child("code-generator");
  }

  async generate(input: GenerateSolutionInput): Promise<SolutionCandidate> {
    this.logger.info("generation-started", {
      attempt: input.attempt,
      feedbackCount: input.feedbackHistory.length,
      language: input.problem.targetLanguage,
    });

    const prompt = buildGenerationPrompt(input);
    this.logger.info("generation-context-compacted", {
      attempt: input.attempt,
      promptChars: estimatePromptChars(CODE_GENERATION_SYSTEM_PROMPT, prompt),
      previousCandidates: input.previousCandidates.length,
      feedbackCount: input.feedbackHistory.length,
      sampleCases: input.problem.sampleCases.length,
    });
    const structured = modelSolutionCandidateSchema.parse(
      await this.model
        .withStructuredOutput(modelSolutionCandidateSchema)
        .invoke(`${CODE_GENERATION_SYSTEM_PROMPT.trim()}\n\n${prompt.trim()}`),
    );

    this.logger.info("generation-finished", {
      attempt: input.attempt,
      language: structured.language,
    });

    return {
      ...structured,
      provider: "openai",
    };
  }
}

function buildGenerationPrompt(input: GenerateSolutionInput): string {
  const feedbackBlock = formatFeedbackHistory(input.feedbackHistory);
  const priorCodeBlock = formatPreviousCandidates(input.previousCandidates);
  const extractionWarnings = formatWarnings(input.problem.extractionWarnings);
  const sampleCases = formatSampleCases(input.problem.sampleCases);
  const compactStatement = compactProblemStatement(input.problem.statement);

  return `
Attempt: ${input.attempt}
Target language: ${input.problem.targetLanguage}

Problem title:
${input.problem.title}

Problem statement:
${compactStatement}

Problem images attached to verifier: ${input.problem.imageAssets.length}

Known sample tests:
${sampleCases}

Extraction warnings:
${extractionWarnings}

Prior failed code:
${priorCodeBlock}

Prior tester feedback:
${feedbackBlock}

Important:
- Treat the extracted statement as coming from screenshots that may include both the problem text and a visible starter template.
- If the statement contains boilerplate code, preserve its interface and fill in the solution within that structure.
- If no explicit template is present, prefer a complete C++17 stdin/stdout solution.
- For hard problems, prioritize the algorithm that provably fits the worst-case bounds even if implementation is more involved.
- Be careful with integer overflow: use long long where values or counts can exceed 32-bit range.
- Cover edge cases such as empty answers, impossible cases, duplicate values, parity conditions, disconnected graph components, and large constraint extremes when relevant.

Return structured output with:
- language
- code
- strategy
- complexity
- assumptions
`;
}

