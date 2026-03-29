import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { providerStrategy } from "langchain";
import {
  solutionCandidateSchema,
  type CodeGenerationAgent,
  type GenerateSolutionInput,
  type SolutionCandidate,
} from "../contracts/agents.js";
import type { Logger } from "../utils/logger.js";

const CODE_GENERATION_SYSTEM_PROMPT = `
You are the Code Generation Agent in a coding-problem solving backend.

Your job:
- Generate a correct solution for the given competitive programming problem.
- Return only one implementation in the requested language.
- Read from standard input and write to standard output.
- Prefer straightforward, reliable code over cleverness.
- If feedback from previous failed attempts exists, directly address it.
- Do not include markdown fences.
`;

export class DeepAgentCodeGenerationAgent implements CodeGenerationAgent {
  readonly role = "code-generator" as const;
  private readonly logger: Logger;
  private readonly model: BaseLanguageModel;
  private agentPromise?: Promise<StructuredAgent>;

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
    const agent = await this.getAgent();
    const result = await agent.invoke({
      messages: [{ role: "user", content: prompt }],
    });

    const structured = solutionCandidateSchema.parse(
      (result as { structuredResponse?: unknown }).structuredResponse,
    );

    this.logger.info("generation-finished", {
      attempt: input.attempt,
      language: structured.language,
    });

    return structured;
  }

  private async getAgent(): Promise<StructuredAgent> {
    this.agentPromise ??= createStructuredDeepAgent(
      this.model,
      CODE_GENERATION_SYSTEM_PROMPT,
      solutionCandidateSchema,
    );

    return await this.agentPromise;
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

  return `
Attempt: ${input.attempt}
Target language: ${input.problem.targetLanguage}

Problem title:
${input.problem.title}

Problem statement:
${input.problem.statement}

Known sample tests:
${JSON.stringify(input.problem.sampleCases, null, 2)}

Prior tester feedback:
${feedbackBlock}

Return structured output with:
- language
- code
- strategy
- complexity
- assumptions
`;
}

type StructuredAgent = {
  invoke(input: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ structuredResponse?: unknown }>;
};

async function createStructuredDeepAgent(
  model: BaseLanguageModel,
  systemPrompt: string,
  schema: typeof solutionCandidateSchema,
): Promise<StructuredAgent> {
  const { createDeepAgent } = await import("deepagents");

  return createDeepAgent({
    model,
    systemPrompt,
    responseFormat: providerStrategy(schema),
  }) as StructuredAgent;
}
