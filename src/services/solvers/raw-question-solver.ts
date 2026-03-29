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

  const solveRequest: StreamedSolveRequest = {
    ...blueprint.suggestedSolveRequest,
    maxAttempts: request.maxAttempts,
    imageAssets: request.imageAssets,
  };

  const result = await solveWithFunctionHarness(solveRequest, logger.child("solver"));

  return {
    blueprint,
    solveRequest,
    result,
  };
}
