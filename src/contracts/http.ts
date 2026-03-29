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
  targetLanguage: z.enum(supportedLanguages).default("cpp"),
  instructions: z.array(z.string()).default([]),
  maxAttempts: z.number().int().positive().max(10).default(4),
  harness: functionHarnessSchema,
  imageAssets: z.array(problemImageAssetSchema).default([]),
});

export type StreamedSolveRequest = z.infer<typeof streamedSolveRequestSchema>;

export const rawQuestionRequestSchema = z.object({
  question: z.string().min(1),
  targetLanguage: z.enum(supportedLanguages).default("cpp"),
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
    "Execution requirements:",
    "- Solve this as an exam-style competitive programming problem.",
    "- Prefer a complete stdin/stdout program unless the statement clearly requires a specific class or function signature.",
    "- If starter code, a required function, or a required class appears in the screenshots or statement, preserve it exactly.",
    "- Use the parsed sample cases as supporting examples, but treat the screenshots and statement as the source of truth.",
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
      .map(mapHarnessTestCaseToProblemCase),
    verificationCases: request.harness.tests
      .filter((testCase) => testCase.source !== "sample")
      .map(mapHarnessTestCaseToProblemCase),
    constraints: [],
    imageAssets: request.imageAssets,
  };
}

function mapHarnessTestCaseToProblemCase(
  testCase: StreamedTestCase,
): z.infer<typeof codingProblemSchema>["sampleCases"][number] {
  const stdin =
    typeof testCase.input.stdin === "string" &&
    Object.keys(testCase.input).length === 1
      ? testCase.input.stdin
      : JSON.stringify(testCase.input);
  const expectedOutput =
    typeof testCase.expected === "string"
      ? testCase.expected
      : JSON.stringify(testCase.expected);

  return {
    name: testCase.name,
    input: stdin,
    expectedOutput,
    source: testCase.source,
  };
}
