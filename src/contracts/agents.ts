import { z } from "zod";
import {
  codingProblemSchema,
  problemTestCaseSchema,
  supportedLanguages,
} from "./problem.js";

export const solutionCandidateSchema = z.object({
  language: z.enum(supportedLanguages),
  code: z.string().min(1),
  strategy: z.string().min(1),
  complexity: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
});

export type SolutionCandidate = z.infer<typeof solutionCandidateSchema>;

export const generationFeedbackSchema = z.object({
  summary: z.string().min(1),
  rootCause: z.string().min(1),
  actionItems: z.array(z.string()).min(1),
  failingCases: z
    .array(
      z.object({
        name: z.string(),
        input: z.string(),
        expectedOutput: z.string(),
        actualOutput: z.string(),
        source: z.string(),
      }),
    )
    .default([]),
});

export type GenerationFeedback = z.infer<typeof generationFeedbackSchema>;

export const testingPlanSchema = z.object({
  reasoning: z.string().min(1),
  coverage: z.array(z.string()).default([]),
  cases: z.array(problemTestCaseSchema).default([]),
});

export type TestingPlan = z.infer<typeof testingPlanSchema>;

export const executedCaseSchema = z.object({
  name: z.string(),
  source: z.string(),
  input: z.string(),
  expectedOutput: z.string(),
  actualOutput: z.string(),
  passed: z.boolean(),
  runtimeError: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export type ExecutedCase = z.infer<typeof executedCaseSchema>;

export const testingReportSchema = z.object({
  status: z.enum(["passed", "failed"]),
  verdict: z.string().min(1),
  executedCases: z.array(executedCaseSchema),
  feedback: generationFeedbackSchema.optional(),
});

export type TestingReport = z.infer<typeof testingReportSchema>;

export const agentRoleSchema = z.enum([
  "supervisor",
  "code-generator",
  "code-tester",
]);

export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentEnvelopeSchema = z.object({
  id: z.string(),
  correlationId: z.string(),
  timestamp: z.string(),
  from: agentRoleSchema,
  to: agentRoleSchema,
  type: z.string(),
  payload: z.unknown(),
});

export type AgentEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof agentEnvelopeSchema>,
  "payload"
> & { payload: TPayload };

export const supervisorRunResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  attemptsUsed: z.number().int().positive(),
  problem: codingProblemSchema,
  finalCandidate: solutionCandidateSchema.optional(),
  finalReport: testingReportSchema,
  transcript: z.array(agentEnvelopeSchema),
});

export type SupervisorRunResult = z.infer<typeof supervisorRunResultSchema>;

export interface GenerateSolutionInput {
  problem: z.infer<typeof codingProblemSchema>;
  attempt: number;
  feedbackHistory: GenerationFeedback[];
  previousCandidates: SolutionCandidate[];
}

export interface TestSolutionInput {
  problem: z.infer<typeof codingProblemSchema>;
  attempt: number;
  candidate: SolutionCandidate;
}

export interface CodeGenerationAgent {
  readonly role: "code-generator";
  generate(input: GenerateSolutionInput): Promise<SolutionCandidate>;
}

export interface CodeTestingAgent {
  readonly role: "code-tester";
  test(input: TestSolutionInput): Promise<TestingReport>;
}
