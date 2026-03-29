import { z } from "zod";
import {
  codingProblemSchema,
  problemImageAssetSchema,
  supportedLanguages,
} from "./problem.js";

export const streamedTestCaseSchema = z.object({
  name: z.string(),
  input: z.object({}).catchall(z.unknown()),
  expected: z.unknown(),
  source: z.enum(["sample", "hidden", "generated"]).default("sample"),
});

export type StreamedTestCase = z.infer<typeof streamedTestCaseSchema>;

export const functionHarnessSchema = z.object({
  functionName: z.string().min(1),
  functionSignature: z.string().min(1),
  invokeExpression: z.string().min(1),
  assertionExpression: z.string().min(1),
  prelude: z.string().default(""),
  tests: z.array(streamedTestCaseSchema).min(1),
});

export type FunctionHarness = z.infer<typeof functionHarnessSchema>;

export const streamedSolveRequestSchema = z.object({
  title: z.string().min(1),
  statement: z.string().min(1),
  targetLanguage: z.enum(supportedLanguages).default("typescript"),
  instructions: z.array(z.string()).default([]),
  maxAttempts: z.number().int().positive().max(10).default(4),
  harness: functionHarnessSchema,
  imageAssets: z.array(problemImageAssetSchema).default([]),
});

export type StreamedSolveRequest = z.infer<typeof streamedSolveRequestSchema>;

export const rawQuestionRequestSchema = z.object({
  question: z.string().min(1),
  targetLanguage: z.enum(supportedLanguages).default("typescript"),
  maxAttempts: z.number().int().positive().max(10).default(4),
  imageAssets: z.array(problemImageAssetSchema).default([]),
});

export type RawQuestionRequest = z.infer<typeof rawQuestionRequestSchema>;

export const extractedExampleSchema = z.object({
  name: z.string(),
  inputText: z.string(),
  outputText: z.string(),
});

export type ExtractedExample = z.infer<typeof extractedExampleSchema>;

export const parsedProblemBlueprintSchema = z.object({
  title: z.string(),
  normalizedStatement: z.string(),
  targetLanguage: z.enum(supportedLanguages),
  detectedStyle: z.enum(["function", "stdin_stdout", "unknown"]).default("unknown"),
  functionName: z.string().optional(),
  functionSignature: z.string().optional(),
  notes: z.array(z.string()).default([]),
  extractedExamples: z.array(extractedExampleSchema).default([]),
  suggestedSolveRequest: streamedSolveRequestSchema.optional(),
});

export type ParsedProblemBlueprint = z.infer<typeof parsedProblemBlueprintSchema>;

export const sseEventSchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  payload: z.unknown(),
});

export type SseEvent = z.infer<typeof sseEventSchema>;

export function buildProblemFromHttpRequest(
  request: StreamedSolveRequest,
): z.infer<typeof codingProblemSchema> {
  const statementParts = [
    request.title,
    "",
    request.statement,
    "",
    "Function requirements:",
    `- Function name: ${request.harness.functionName}`,
    `- Signature: ${request.harness.functionSignature}`,
    "- Return only the function implementation.",
    "- Do not read from stdin or write to stdout.",
    ...request.instructions.map((instruction) => `- ${instruction}`),
  ];

  return {
    id: crypto.randomUUID(),
    title: request.title,
    rawText: statementParts.join("\n"),
    statement: statementParts.join("\n"),
    targetLanguage: request.targetLanguage,
    sampleCases: request.harness.tests
      .filter((testCase) => testCase.source === "sample")
      .map((testCase) => ({
        name: testCase.name,
        input: JSON.stringify(testCase.input),
        expectedOutput: JSON.stringify(testCase.expected),
        source: testCase.source,
      })),
    verificationCases: request.harness.tests
      .filter((testCase) => testCase.source !== "sample")
      .map((testCase) => ({
        name: testCase.name,
        input: JSON.stringify(testCase.input),
        expectedOutput: JSON.stringify(testCase.expected),
        source: testCase.source,
      })),
    constraints: [],
    imageAssets: request.imageAssets,
  };
}
