import { describe, expect, test } from "bun:test";
import { parseRawQuestionToBlueprint } from "../src/services/parsing/problem-blueprint-agent.js";
import { MemoryLogger } from "../src/utils/logger.js";

describe("parseRawQuestionToBlueprint", () => {
  test("builds a deterministic function harness from OCR-style examples without a signature", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const blueprint = await parseRawQuestionToBlueprint(
        {
          question: `
Regular Expression Matching

Given an input string s and a pattern p, implement regular expression matching with support for '.' and '*' where:
'.' Matches any single character.
'*' Matches zero or more of the preceding element.
Return a boolean indicating whether the matching covers the entire input string (not partial).

Example 1:
Input: s = "aa", p = "a"
Output: false

Example 2:
Input: s = "aa", p = "a*"
Output: true

Example 3:
Input: s = "ab", p = ".*"
Output: true
          `.trim(),
          targetLanguage: "typescript",
          maxAttempts: 4,
        },
        new MemoryLogger("test"),
      );

      expect(blueprint.detectedStyle).toBe("function");
      expect(blueprint.functionName).toBe("isMatch");
      expect(blueprint.functionSignature).toBe(
        "function isMatch(s: string, p: string): boolean",
      );
      expect(blueprint.suggestedSolveRequest).toBeDefined();
      expect(blueprint.suggestedSolveRequest?.harness.tests).toHaveLength(3);
      expect(blueprint.suggestedSolveRequest?.harness.invokeExpression).toBe(
        "isMatch(testCase.input.s, testCase.input.p)",
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });
});
