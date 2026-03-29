import {
  parsedProblemBlueprintSchema,
  rawQuestionRequestSchema,
  streamedSolveRequestSchema,
  type ExtractedExample,
  type ParsedProblemBlueprint,
  type RawQuestionRequest,
  type StreamedSolveRequest,
} from "../../contracts/http.js";
import { createOpenAIChatModel } from "../llm/openai-chat-model.js";
import type { Logger } from "../../utils/logger.js";
import { z } from "zod";

const FUNCTION_SIGNATURE_PATTERN =
  /function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:\s*([^\n{]+)/i;
const EXAMPLE_PATTERN =
  /Example\s+(\d+):\s*Input:\s*([\s\S]*?)\s*Output:\s*([\s\S]*?)(?=\n\s*Example\s+\d+:|\n\s*Constraints:|$)/gi;
const MERGE_K_LISTS_PATTERN =
  /array of k linked-lists|merge all the linked-lists|merge k sorted lists/i;
const LIST_NODE_PRELUDE = `
class ListNode {
  val: number;
  next: ListNode | null;

  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function buildList(values: number[]): ListNode | null {
  const dummy = new ListNode();
  let tail = dummy;

  for (const value of values) {
    tail.next = new ListNode(value);
    tail = tail.next;
  }

  return dummy.next;
}

function buildLists(values: number[][]): Array<ListNode | null> {
  return values.map(buildList);
}

function listToArray(head: ListNode | null): number[] {
  const result: number[] = [];
  let current = head;

  while (current) {
    result.push(current.val);
    current = current.next;
  }

  return result;
}
`.trim();
const modelParsedProblemSchema = z.object({
  title: z.string().min(1),
  normalizedStatement: z.string().min(1),
  targetLanguage: z.enum(["cpp", "typescript", "javascript", "python"]),
  detectedStyle: z.enum(["function", "stdin_stdout", "unknown"]),
  functionName: z.string().nullable(),
  functionSignature: z.string().nullable(),
  notes: z.array(z.string()),
  extractedExamples: z.array(
    z.object({
      name: z.string(),
      inputText: z.string(),
      outputText: z.string(),
    }),
  ),
});
const inferredHarnessSchema = z.object({
  functionName: z.string().min(1),
  functionSignature: z.string().min(1),
  invokeExpression: z.string().min(1),
  assertionExpression: z.string().min(1),
  prelude: z.string(),
  instructions: z.array(z.string()),
});

export async function parseRawQuestionToBlueprint(
  request: RawQuestionRequest,
  logger: Logger,
): Promise<ParsedProblemBlueprint> {
  const fallback = buildRegexFallback(request, logger);
  const deterministicTemplate = buildKnownProblemTemplate(request, logger);
  const apiKeyAvailable = Boolean(process.env.OPENAI_API_KEY);

  if (deterministicTemplate) {
    logger.info("parser-template-selected", {
      title: deterministicTemplate.title,
      detectedStyle: deterministicTemplate.detectedStyle,
    });
    return deterministicTemplate;
  }

  if (!apiKeyAvailable) {
    logger.warn("parser-fallback-no-openai-key");
    const heuristicSolveRequest = buildHeuristicSolveRequest(
      request,
      fallback,
      fallback,
      logger,
    );
    if (heuristicSolveRequest) {
      return {
        ...fallback,
        detectedStyle: "function",
        functionName: heuristicSolveRequest.harness.functionName,
        functionSignature: heuristicSolveRequest.harness.functionSignature,
        notes: [
          ...fallback.notes,
          "Built suggested solve request via deterministic sample-based inference.",
        ],
        suggestedSolveRequest: heuristicSolveRequest,
      };
    }

    return fallback;
  }

  const model = createOpenAIChatModel({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    temperature: 0,
  });

  try {
    const runnable = model.withStructuredOutput(modelParsedProblemSchema);

    logger.info("parser-agent-started", {
      title: fallback.title,
      detectedStyle: fallback.detectedStyle,
    });

    const result = await runnable.invoke(`
You convert raw coding-problem text into deterministic JSON for a later solve pipeline.

Rules:
- Return JSON only through the structured schema.
- Prefer exact extraction from the question text.
- These inputs are often exam-style screenshots with sections like Input Format, Constraints, Sample Test Cases, and explanations.
- Preserve any visible starter code, predefined class/function signatures, and required method names in normalizedStatement.
- Prefer detectedStyle = "stdin_stdout" unless the problem clearly requires a fixed callable signature.
- If you are not confident enough to build a valid solve request, leave suggestedSolveRequest undefined.
- When you can infer a function-style problem, build suggestedSolveRequest compatible with the solver API.
- Do not invent hidden tests.
- Use the extracted examples only.

Fallback extraction:
${JSON.stringify(fallback, null, 2)}

Raw question:
${request.question}
    `.trim());

    const extracted = modelParsedProblemSchema.parse(result);
    const parsed = parsedProblemBlueprintSchema.parse({
      ...extracted,
      functionName: extracted.functionName ?? undefined,
      functionSignature: extracted.functionSignature ?? undefined,
      suggestedSolveRequest: undefined,
    });
    logger.info("parser-agent-finished", {
      title: parsed.title,
      hasSuggestedSolveRequest: false,
    });

    const inferredSolveRequest = await inferSolveRequestWithModel(
      model,
      request,
      {
        ...parsed,
        suggestedSolveRequest: undefined,
      },
      fallback,
      logger,
    );

    if (inferredSolveRequest) {
      return {
        ...parsed,
        detectedStyle: "function",
        functionName:
          parsed.functionName ?? inferredSolveRequest.harness.functionName,
        functionSignature:
          parsed.functionSignature ?? inferredSolveRequest.harness.functionSignature,
        notes: [
          ...parsed.notes,
          "Built suggested solve request via model inference from OCR/raw text.",
        ],
        suggestedSolveRequest: inferredSolveRequest,
      };
    }

    const heuristicSolveRequest = buildHeuristicSolveRequest(
      request,
      parsed,
      fallback,
      logger,
    );
    if (heuristicSolveRequest) {
      return {
        ...parsed,
        detectedStyle: "function",
        functionName: heuristicSolveRequest.harness.functionName,
        functionSignature: heuristicSolveRequest.harness.functionSignature,
        notes: [
          ...parsed.notes,
          "Built suggested solve request via deterministic sample-based inference.",
        ],
        suggestedSolveRequest: heuristicSolveRequest,
      };
    }

    if (fallback.suggestedSolveRequest) {
      return {
        ...parsed,
        suggestedSolveRequest: fallback.suggestedSolveRequest,
        notes: [...parsed.notes, "Used regex fallback suggested solve request."],
      };
    }

    return parsed;
  } catch (error) {
    logger.warn("parser-agent-fallback", {
      reason: error instanceof Error ? error.message : "unknown error",
    });

    const inferredSolveRequest = await inferSolveRequestWithModel(
      model,
      request,
      fallback,
      fallback,
      logger,
    );

    if (inferredSolveRequest) {
      return {
        ...fallback,
        detectedStyle: "function",
        functionName: inferredSolveRequest.harness.functionName,
        functionSignature: inferredSolveRequest.harness.functionSignature,
        notes: [
          ...fallback.notes,
          "Built suggested solve request via model inference after parser fallback.",
        ],
        suggestedSolveRequest: inferredSolveRequest,
      };
    }

    const heuristicSolveRequest = buildHeuristicSolveRequest(
      request,
      fallback,
      fallback,
      logger,
    );
    if (heuristicSolveRequest) {
      return {
        ...fallback,
        detectedStyle: "function",
        functionName: heuristicSolveRequest.harness.functionName,
        functionSignature: heuristicSolveRequest.harness.functionSignature,
        notes: [
          ...fallback.notes,
          "Built suggested solve request via deterministic sample-based inference.",
        ],
        suggestedSolveRequest: heuristicSolveRequest,
      };
    }

    return fallback;
  }
}

async function inferSolveRequestWithModel(
  model: ReturnType<typeof createOpenAIChatModel>,
  request: RawQuestionRequest,
  parsed: ParsedProblemBlueprint,
  fallback: ParsedProblemBlueprint,
  logger: Logger,
): Promise<StreamedSolveRequest | undefined> {
  try {
    const runnable = model.withStructuredOutput(inferredHarnessSchema);

    logger.info("parser-solve-request-inference-started", {
      title: parsed.title,
      extractedExamples: parsed.extractedExamples.length,
    });

    const inferred = inferredHarnessSchema.parse(
      await runnable.invoke(`
You infer the function harness metadata needed to solve a coding problem.

Rules:
- Return JSON only through the structured schema.
- Prefer a function-style harness.
- These questions may be exam-style stdin/stdout problems without an explicit function signature.
- If the exact function signature is missing, infer the most likely canonical LeetCode-style signature from the problem title, statement, and examples.
- Use the example input variable names when building the signature and invoke expression.
- Return only metadata for a single function implementation requirement, not stdin/stdout.
- Use "JSON.stringify(actual) === JSON.stringify(testCase.expected)" as the assertion unless the problem clearly needs helpers.
- Keep harness.prelude empty unless helper types or converters are required.
- The output must be usable by a TypeScript solver.

Existing parsed blueprint:
${JSON.stringify(parsed, null, 2)}

Regex fallback:
${JSON.stringify(fallback, null, 2)}

Raw question:
${request.question}
      `.trim()),
    );

    const extractedExamples =
      parsed.extractedExamples.length > 0
        ? parsed.extractedExamples
        : fallback.extractedExamples;
    const tests = extractedExamples
      .map((example, index) => {
        const input = parseExampleInput(example.inputText);
        const expected = parseLiteral(example.outputText);

        if (!input || typeof input !== "object") {
          return null;
        }

        return {
          name: example.name || `example-${index + 1}`,
          input,
          expected,
          source: "sample" as const,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    if (tests.length === 0) {
      logger.warn("parser-solve-request-inference-no-tests");
      return undefined;
    }

    const solveRequest = streamedSolveRequestSchema.parse({
      title: parsed.title,
      statement: parsed.normalizedStatement,
      targetLanguage: request.targetLanguage,
        instructions: [
          `The function must be named ${inferred.functionName}.`,
          `The signature is ${inferred.functionSignature}.`,
        "If the original problem is exam-style stdin/stdout, the generator may still return a full program; use this harness only as parsed sample structure.",
        ...inferred.instructions,
      ],
      maxAttempts: request.maxAttempts,
      harness: {
        functionName: inferred.functionName,
        functionSignature: inferred.functionSignature,
        invokeExpression: inferred.invokeExpression,
        assertionExpression: inferred.assertionExpression,
        prelude: inferred.prelude,
        tests,
      },
    });

    logger.info("parser-solve-request-inference-finished", {
      title: solveRequest.title,
      functionName: solveRequest.harness.functionName,
      tests: solveRequest.harness.tests.length,
    });

    return solveRequest;
  } catch (error) {
    logger.warn("parser-solve-request-inference-failed", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return undefined;
  }
}

function buildHeuristicSolveRequest(
  request: RawQuestionRequest,
  parsed: ParsedProblemBlueprint,
  fallback: ParsedProblemBlueprint,
  logger: Logger,
): StreamedSolveRequest | undefined {
  const extractedExamples =
    parsed.extractedExamples.length > 0
      ? parsed.extractedExamples
      : fallback.extractedExamples;
  if (extractedExamples.length === 0) {
    logger.warn("parser-heuristic-inference-no-examples");
    return undefined;
  }

  const parsedTests = extractedExamples
    .map((example, index) => {
      const input = parseExampleInput(example.inputText);
      if (!input || Object.keys(input).length === 0) {
        return null;
      }

      return {
        name: example.name || `example-${index + 1}`,
        input,
        expected: parseLiteral(example.outputText),
        source: "sample" as const,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (parsedTests.length === 0) {
    logger.warn("parser-heuristic-inference-no-parseable-tests");
    return undefined;
  }

  const firstTest = parsedTests[0];
  if (!firstTest) {
    logger.warn("parser-heuristic-inference-missing-first-test");
    return undefined;
  }

  const parameterNames = Object.keys(firstTest.input);
  if (parameterNames.length === 0) {
    logger.warn("parser-heuristic-inference-no-parameters");
    return undefined;
  }

  const functionName = inferHeuristicFunctionName(
    parsed.title,
    parsed.normalizedStatement,
    parameterNames,
    firstTest.expected,
  );
  const functionSignature = `function ${functionName}(${parameterNames
    .map((name) => `${name}: ${inferParameterType(parsedTests, name)}`)
    .join(", ")}): ${inferReturnType(parsedTests)}`;

  const solveRequest = streamedSolveRequestSchema.parse({
    title: parsed.title,
    statement: parsed.normalizedStatement,
    targetLanguage: request.targetLanguage,
    instructions: [
      `The function must be named ${functionName}.`,
      `The signature is ${functionSignature}.`,
      "If the original problem is exam-style stdin/stdout, treat this harness as parsed sample structure rather than a strict implementation interface.",
      "The function name and signature were inferred deterministically from the title and sample inputs.",
    ],
    maxAttempts: request.maxAttempts,
    harness: {
      functionName,
      functionSignature,
      invokeExpression: `${functionName}(${parameterNames
        .map((name) => `testCase.input.${name}`)
        .join(", ")})`,
      assertionExpression:
        "JSON.stringify(actual) === JSON.stringify(testCase.expected)",
      prelude: "",
      tests: parsedTests,
    },
  });

  logger.info("parser-heuristic-inference-finished", {
    title: solveRequest.title,
    functionName,
    tests: solveRequest.harness.tests.length,
  });

  return solveRequest;
}

function buildRegexFallback(
  request: RawQuestionRequest,
  logger: Logger,
): ParsedProblemBlueprint {
  const question = request.question.trim();
  const title = extractTitle(question);
  const extractedExamples = extractExamples(question);
  const signatureMatch = question.match(FUNCTION_SIGNATURE_PATTERN);
  const functionName = signatureMatch?.[1];
  const functionSignature = signatureMatch?.[0]?.trim();
  const parameterNames = functionSignature
    ? extractParameterNames(functionSignature)
    : [];

  let suggestedSolveRequest: StreamedSolveRequest | undefined;
  if (
    functionName &&
    functionSignature &&
    extractedExamples.length > 0 &&
    parameterNames.length > 0
  ) {
    const tests = extractedExamples
      .map((example, index) => {
        const input = parseExampleInput(example.inputText);
        const expected = parseLiteral(example.outputText);

        if (!input || typeof input !== "object") {
          return null;
        }

        return {
          name: example.name || `example-${index + 1}`,
          input,
          expected,
          source: "sample" as const,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    if (tests.length > 0) {
      suggestedSolveRequest = streamedSolveRequestSchema.parse({
        title,
        statement: question,
        targetLanguage: request.targetLanguage,
        instructions: [
          `The function must be named ${functionName}.`,
          `The signature is ${functionSignature}.`,
          "If the original problem is exam-style stdin/stdout, treat this harness as sample-case structure rather than a strict implementation interface.",
        ],
        maxAttempts: request.maxAttempts,
        harness: {
          functionName,
          functionSignature,
          invokeExpression: `${functionName}(${parameterNames
            .map((name) => `testCase.input.${name}`)
            .join(", ")})`,
          assertionExpression:
            "JSON.stringify(actual) === JSON.stringify(testCase.expected)",
          prelude: "",
          tests,
        },
      });
    }
  }

  const detectedStyle =
    functionName && functionSignature ? "function" : "unknown";

  logger.info("parser-regex-fallback-built", {
    title,
    detectedStyle,
    hasSuggestedSolveRequest: Boolean(suggestedSolveRequest),
  });

  return {
    title,
    normalizedStatement: question,
    targetLanguage: request.targetLanguage,
    detectedStyle,
    functionName,
    functionSignature,
    notes: suggestedSolveRequest
      ? ["Built suggested solve request via regex extraction."]
      : ["Could not build a solve request confidently from regex extraction."],
    extractedExamples,
    suggestedSolveRequest,
  };
}

function buildKnownProblemTemplate(
  request: RawQuestionRequest,
  logger: Logger,
): ParsedProblemBlueprint | null {
  const question = request.question.trim();
  const title = extractTitle(question);

  if (MERGE_K_LISTS_PATTERN.test(question)) {
    const extractedExamples = extractExamples(question);
    const tests = extractedExamples
      .map((example, index) => {
        const input = parseExampleInput(example.inputText);
        const expected = parseLiteral(example.outputText);

        if (
          !input ||
          !("lists" in input) ||
          !Array.isArray(input.lists) ||
          !Array.isArray(expected)
        ) {
          return null;
        }

        return {
          name: example.name || `example-${index + 1}`,
          input: {
            lists: input.lists,
          },
          expected,
          source: "sample" as const,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    const suggestedSolveRequest =
      tests.length > 0
        ? streamedSolveRequestSchema.parse({
            title,
            statement: question,
            targetLanguage: request.targetLanguage,
            instructions: [
              "The function must be named mergeKLists.",
              "The signature is function mergeKLists(lists: Array<ListNode | null>): ListNode | null.",
              "If the original problem includes starter code, preserve the required interface exactly.",
              "Use the provided ListNode definition from the harness.",
            ],
            maxAttempts: request.maxAttempts,
            harness: {
              functionName: "mergeKLists",
              functionSignature:
                "function mergeKLists(lists: Array<ListNode | null>): ListNode | null",
              invokeExpression:
                "mergeKLists(buildLists(testCase.input.lists as number[][]))",
              assertionExpression:
                "JSON.stringify(listToArray(actual)) === JSON.stringify(testCase.expected)",
              prelude: LIST_NODE_PRELUDE,
              tests,
            },
          })
        : undefined;

    logger.info("parser-known-template-built", {
      title,
      template: "merge-k-sorted-lists",
      hasSuggestedSolveRequest: Boolean(suggestedSolveRequest),
    });

    return {
      title,
      normalizedStatement: question,
      targetLanguage: request.targetLanguage,
      detectedStyle: "function",
      functionName: "mergeKLists",
      functionSignature:
        "function mergeKLists(lists: Array<ListNode | null>): ListNode | null",
      notes: [
        "Used deterministic linked-list template for Merge k Sorted Lists.",
      ],
      extractedExamples,
      suggestedSolveRequest,
    };
  }

  return null;
}

function extractTitle(question: string): string {
  const lines = question
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] ?? "Untitled Problem";
}

function extractExamples(question: string): ExtractedExample[] {
  const examples: ExtractedExample[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = EXAMPLE_PATTERN.exec(question)) !== null) {
    const exampleNumber = match[1] ?? String(examples.length + 1);
    const inputText = match[2]?.trim() ?? "";
    const outputBlock = match[3]?.trim() ?? "";
    const outputText = outputBlock.split(/\n\s*Explanation:/i)[0]?.trim() ?? "";

    if (!inputText || !outputText) {
      continue;
    }

    examples.push({
      name: `example-${exampleNumber}`,
      inputText,
      outputText,
    });
  }

  return examples;
}

function extractParameterNames(functionSignature: string): string[] {
  const match = functionSignature.match(FUNCTION_SIGNATURE_PATTERN);
  if (!match?.[2]) {
    return [];
  }

  return match[2]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0]?.trim() ?? "")
    .filter(Boolean);
}

function parseExampleInput(inputText: string): Record<string, unknown> | null {
  const assignments = inputText
    .split(/,\s*(?=[A-Za-z_]\w*\s*=)/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (assignments.length === 0) {
    return null;
  }

  const result: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const equalIndex = assignment.indexOf("=");
    if (equalIndex === -1) {
      return null;
    }

    const key = assignment.slice(0, equalIndex).trim();
    const valueText = assignment.slice(equalIndex + 1).trim();

    if (!key) {
      return null;
    }

    result[key] = parseLiteral(valueText);
  }

  return result;
}

function parseLiteral(valueText: string): unknown {
  const trimmed = valueText.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed.replace(/'/g, "\""));
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function inferHeuristicFunctionName(
  title: string,
  statement: string,
  parameterNames: string[],
  expected: unknown,
): string {
  const normalizedTitle = title.toLowerCase();
  const normalizedStatement = statement.toLowerCase();

  if (
    /regular expression matching/.test(normalizedTitle) ||
    /regular expression matching/.test(normalizedStatement)
  ) {
    return "isMatch";
  }

  if (/two sum/.test(normalizedTitle)) {
    return "twoSum";
  }

  if (/valid parentheses/.test(normalizedTitle)) {
    return "isValid";
  }

  if (/palindrome/.test(normalizedTitle) && typeof expected === "boolean") {
    return "isPalindrome";
  }

  if (
    typeof expected === "boolean" &&
    parameterNames.length === 2 &&
    parameterNames.includes("s") &&
    parameterNames.includes("p")
  ) {
    return "isMatch";
  }

  const normalizedWords = title
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (normalizedWords.length === 0) {
    return "solve";
  }

  return normalizedWords
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) {
        return lower;
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function inferParameterType(
  tests: Array<{
    input: Record<string, unknown>;
  }>,
  parameterName: string,
): string {
  return inferCommonType(
    tests.map((test) => test.input[parameterName]),
    "unknown",
  );
}

function inferReturnType(
  tests: Array<{
    expected: unknown;
  }>,
): string {
  return inferCommonType(
    tests.map((test) => test.expected),
    "unknown",
  );
}

function inferCommonType(values: unknown[], fallback: string): string {
  const inferred = values.map(inferValueTypeAnnotation);
  const unique = Array.from(new Set(inferred.filter(Boolean)));

  if (unique.length === 0) {
    return fallback;
  }

  if (unique.length === 1) {
    return unique[0]!;
  }

  const nonNull = unique.filter((value) => value !== "null");
  if (nonNull.length === 1 && unique.length === 2) {
    return `${nonNull[0]} | null`;
  }

  return fallback;
}

function inferValueTypeAnnotation(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "object":
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return "unknown[]";
        }

        const elementType = inferCommonType(value, "unknown");
        return `Array<${elementType}>`;
      }

      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}
