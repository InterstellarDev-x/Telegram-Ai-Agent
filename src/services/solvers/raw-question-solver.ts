import type { SupervisorRunResult } from "../../contracts/agents.js";
import type {
  ParsedProblemBlueprint,
  RawQuestionRequest,
  StreamedSolveRequest,
} from "../../contracts/http.js";
import { parseRawQuestionToBlueprint } from "../parsing/problem-blueprint-agent.js";
import { solveWithFunctionHarness } from "./function-harness-solver.js";
import type { Logger } from "../../utils/logger.js";

export interface RawQuestionSolveResult {
  blueprint: ParsedProblemBlueprint;
  solveRequest: StreamedSolveRequest;
  result: SupervisorRunResult;
}

export async function solveRawQuestion(
  request: RawQuestionRequest,
  logger: Logger,
): Promise<RawQuestionSolveResult> {
  const blueprint = await parseRawQuestionToBlueprint(request, logger.child("parser"));

  if (!blueprint.suggestedSolveRequest) {
    throw new Error(
      "Could not deterministically build a solve request from the raw question.",
    );
  }

  const candidateSolveRequests = [
    blueprint.suggestedSolveRequest,
    ...blueprint.alternateSolveRequests,
  ]
    .filter((value): value is StreamedSolveRequest => Boolean(value))
    .map((solveRequest, index) => ({
      ...solveRequest,
      maxAttempts: index === 0 ? request.maxAttempts : Math.min(request.maxAttempts, 2),
      imageAssets: request.imageAssets,
      extractionWarnings: request.extractionWarnings,
      artifactId: request.artifactId,
    }));

  const primarySolveRequest = candidateSolveRequests[0];
  if (!primarySolveRequest) {
    throw new Error("No solve requests were available after parsing the raw question.");
  }

  let solveRequest = primarySolveRequest;
  let result = await solveWithFunctionHarness(solveRequest, logger.child("solver"));

  for (const alternateSolveRequest of candidateSolveRequests.slice(1)) {
    if (result.status === "passed" && result.finalCandidate) {
      break;
    }

    logger.warn("raw-question-primary-solve-failed", {
      primaryStyle: blueprint.detectedStyle,
      retryStyle: inferSolveRequestStyle(alternateSolveRequest),
    });
    solveRequest = alternateSolveRequest;
    result = await solveWithFunctionHarness(
      alternateSolveRequest,
      logger.child("solver-alternate"),
    );
  }

  return {
    blueprint,
    solveRequest,
    result,
  };
}

function inferSolveRequestStyle(request: StreamedSolveRequest): "function" | "stdin_stdout" {
  return request.harness.functionName === "solve" &&
    request.harness.tests.every((test) => typeof test.input.stdin === "string")
    ? "stdin_stdout"
    : "function";
}
