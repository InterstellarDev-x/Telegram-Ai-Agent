import {
  parsedProblemBlueprintSchema,
  rawQuestionRequestSchema,
  streamedSolveRequestSchema,
  type ExtractedExample,
  type ParsedProblemBlueprint,
  type RawQuestionRequest,
  type StreamedSolveRequest,
} from "../../contracts/http.ts";
import { createOpenAIChatModel } from "../llm/openai-chat-model.ts";
import type { Logger } from "../../utils/logger.ts";

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
    return fallback;
  }

  try {
    const model = createOpenAIChatModel({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1",
      temperature: 0,
    });
    const runnable = model.withStructuredOutput(parsedProblemBlueprintSchema);

    logger.info("parser-agent-started", {
      title: fallback.title,
      detectedStyle: fallback.detectedStyle,
    });

    const result = await runnable.invoke(`
You convert raw coding-problem text into deterministic JSON for a later solve pipeline.

Rules:
- Return JSON only through the structured schema.
- Prefer exact extraction from the question text.
- If you are not confident enough to build a valid solve request, leave suggestedSolveRequest undefined.
- When you can infer a function-style problem, build suggestedSolveRequest compatible with the solver API.
- Do not invent hidden tests.
- Use the extracted examples only.

Fallback extraction:
${JSON.stringify(fallback, null, 2)}

Raw question:
${request.question}
    `.trim());

    const parsed = parsedProblemBlueprintSchema.parse(result);
    logger.info("parser-agent-finished", {
      title: parsed.title,
      hasSuggestedSolveRequest: Boolean(parsed.suggestedSolveRequest),
    });

    if (!parsed.suggestedSolveRequest && fallback.suggestedSolveRequest) {
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
    return fallback;
  }
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
          "Return only the function implementation.",
          "Do not read from stdin or write to stdout.",
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
              "Return only the function implementation.",
              "Do not read from stdin or write to stdout.",
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
