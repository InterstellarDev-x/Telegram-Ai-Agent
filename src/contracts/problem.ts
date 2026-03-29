import { z } from "zod";

export const supportedLanguages = ["cpp", "javascript", "typescript", "python"] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

export const testCaseSourceSchema = z.enum(["sample", "hidden", "generated"]);
export type TestCaseSource = z.infer<typeof testCaseSourceSchema>;

export const problemTestCaseSchema = z.object({
  name: z.string(),
  input: z.string(),
  expectedOutput: z.string(),
  source: testCaseSourceSchema.default("sample"),
  rationale: z.string().optional(),
});

export type ProblemTestCase = z.infer<typeof problemTestCaseSchema>;

export const problemImageAssetSchema = z.object({
  mimeType: z.string().min(1),
  dataUrl: z.string().min(1),
  caption: z.string().optional(),
});

export type ProblemImageAsset = z.infer<typeof problemImageAssetSchema>;

export const codingProblemSchema = z.object({
  id: z.string(),
  title: z.string(),
  rawText: z.string(),
  statement: z.string(),
  targetLanguage: z.enum(supportedLanguages).default("cpp"),
  sampleCases: z.array(problemTestCaseSchema).default([]),
  verificationCases: z.array(problemTestCaseSchema).default([]),
  constraints: z.array(z.string()).default([]),
  imageAssets: z.array(problemImageAssetSchema).default([]),
});

export type CodingProblem = z.infer<typeof codingProblemSchema>;

export const solveProblemRequestSchema = z.object({
  problem: codingProblemSchema,
  maxAttempts: z.number().int().positive().max(10).default(4),
});

export type SolveProblemRequest = z.infer<typeof solveProblemRequestSchema>;
