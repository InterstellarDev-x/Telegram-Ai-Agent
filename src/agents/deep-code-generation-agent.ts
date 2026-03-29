import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  solutionCandidateSchema,
  type CodeGenerationAgent,
  type GenerateSolutionInput,
  type SolutionCandidate,
} from "../contracts/agents.js";
import type { Logger } from "../utils/logger.js";

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
  private readonly logger: Logger;
  private readonly model: BaseLanguageModel;

  constructor(model: BaseLanguageModel, logger: Logger) {
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
    const structured = modelSolutionCandidateSchema.parse(
      await invokeStructuredModel(
        this.model,
        CODE_GENERATION_SYSTEM_PROMPT,
        prompt,
        modelSolutionCandidateSchema,
      ),
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
  const feedbackBlock =
    input.feedbackHistory.length === 0
      ? "No prior tester feedback."
      : input.feedbackHistory
          .map(
            (feedback, index) => `Attempt ${index + 1} feedback:
summary: ${feedback.summary}
rootCause: ${feedback.rootCause}
actionItems:
${feedback.actionItems.map((item) => `- ${item}`).join("\n")}`,
          )
          .join("\n\n");
  const priorCodeBlock =
    input.previousCandidates.length === 0
      ? "No prior failed code."
      : input.previousCandidates
          .map(
            (candidate, index) => `Attempt ${index + 1} code:
language: ${candidate.language}
strategy: ${candidate.strategy}
code:
${candidate.code}`,
          )
          .join("\n\n");
  const extractionWarnings =
    input.problem.extractionWarnings.length === 0
      ? "No extraction warnings."
      : input.problem.extractionWarnings.map((warning) => `- ${warning}`).join("\n");

  return `
Attempt: ${input.attempt}
Target language: ${input.problem.targetLanguage}

Problem title:
${input.problem.title}

Problem statement:
${input.problem.statement}

Problem images attached to verifier: ${input.problem.imageAssets.length}

Known sample tests:
${JSON.stringify(input.problem.sampleCases, null, 2)}

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

type StructuredAgent = {
  withStructuredOutput(schema: unknown): {
    invoke(input: string): Promise<unknown>;
  };
};

async function invokeStructuredModel(
  model: BaseLanguageModel,
  systemPrompt: string,
  userPrompt: string,
  schema: typeof modelSolutionCandidateSchema,
): Promise<unknown> {
  const structuredModel = model as BaseLanguageModel & StructuredAgent;
  if (typeof structuredModel.withStructuredOutput !== "function") {
    throw new Error("Configured model does not support structured output.");
  }

  const runnable = structuredModel.withStructuredOutput(schema);
  return await runnable.invoke(
    `${systemPrompt.trim()}\n\n${userPrompt.trim()}`,
  );
}
