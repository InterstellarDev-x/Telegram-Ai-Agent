import { CallbackLogger } from "./utils/logger.js";
import { createSseResponse, SseEventStream } from "./services/streaming/sse.js";
import {
  rawQuestionRequestSchema,
  streamedSolveRequestSchema,
  type RawQuestionRequest,
  type StreamedSolveRequest,
} from "./contracts/http.js";
import { createApiCredentialRequestSchema } from "./contracts/api-credential.js";
import { getKeyPool, resetPoolSingletons, isPoolInitialized, checkProviderHasKeys } from "./services/llm/key-pool/key-pool-factory.js";

export async function handleHttpRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method === "GET" && pathname === "/health") {
    return jsonResponse({
      ok: true,
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && pathname === "/telegram/health") {
    const openAiConfigured = await checkProviderHasKeys("openai");
    const geminiConfigured = await checkProviderHasKeys("gemini");

    return jsonResponse({
      ok: true,
      timestamp: new Date().toISOString(),
      webhookPath: "/telegram/webhook",
      telegramBotConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      upstashConfigured: Boolean(
        process.env.UPSTASH_REDIS_REST_URL?.trim() &&
          process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
      ),
      openAiConfigured,
      geminiConfigured,
    });
  }

  if (request.method === "POST" && pathname === "/solve/stream") {
    return await handleStreamSolve(request);
  }

  if (request.method === "POST" && pathname === "/solve/from-text/stream") {
    return await handleStreamSolveFromText(request);
  }

  if (request.method === "POST" && pathname === "/parse/problem") {
    return await handleParseProblem(request);
  }

  if (request.method === "POST" && pathname === "/telegram/webhook") {
    return await handleTelegramWebhook(request);
  }

  if (request.method === "POST" && pathname === "/admin/api-keys") {
    return await handleCreateApiCredential(request);
  }

  if (request.method === "GET" && pathname === "/pool/stats") {
    return await handlePoolStats(request);
  }

  if (request.method === "POST" && pathname === "/pool/reset") {
    return await handlePoolReset(request);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleStreamSolve(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = streamedSolveRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const stream = new SseEventStream();
  void runSolve(parsed.data, stream);
  return createSseResponse(stream.stream);
}

async function handleStreamSolveFromText(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = rawQuestionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const stream = new SseEventStream();
  void runSolveFromText(parsed.data, stream);
  return createSseResponse(stream.stream);
}

async function handleParseProblem(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = rawQuestionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const logger = new CallbackLogger("parser-api", () => {});
  const { parseRawQuestionToBlueprint } = await import(
    "./services/parsing/problem-blueprint-agent.js"
  );
  const blueprint = await parseRawQuestionToBlueprint(parsed.data, logger);
  return jsonResponse(blueprint);
}

async function handleTelegramWebhook(request: Request): Promise<Response> {
  try {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

    if (!telegramBotToken) {
      return jsonResponse(
        {
          error: "TELEGRAM_BOT_TOKEN is not configured.",
        },
        503,
      );
    }

    const { processTelegramUpdate, validateTelegramWebhookRequest } = await import(
      "./services/telegram/telegram-webhook.js"
    );
    const update = await validateTelegramWebhookRequest(request);
    const logger = new CallbackLogger("telegram-webhook", (entry) => {
      console.log(JSON.stringify(entry));
    });

    await processTelegramUpdate(update, logger);

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Invalid Telegram webhook",
      },
      400,
    );
  }
}

async function handleCreateApiCredential(request: Request): Promise<Response> {
  const secret = process.env.API_KEY_ADMIN_SECRET?.trim();
  if (!secret) {
    return jsonResponse(
      { error: "API key admin endpoint is disabled. Set API_KEY_ADMIN_SECRET." },
      403,
    );
  }

  const provided = request.headers.get("x-admin-secret")?.trim();
  if (provided !== secret) {
    return jsonResponse(
      { error: "Invalid or missing x-admin-secret header." },
      401,
    );
  }

  const body = await safeReadJson(request);
  const parsed = createApiCredentialRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  try {
    const { prisma } = await import("./services/storage/prisma.js");
    const credential = await prisma.apiCredential.create({
      data: parsed.data,
    });

    // Invalidate the running pool instantly so next acquire reads the new keys
    await resetPoolSingletons();

    return jsonResponse(
      {
        ok: true,
        credential: {
          id: credential.id,
          provider: credential.provider,
          label: credential.label,
          model: credential.model,
          isActive: credential.isActive,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
          apiKeyPreview: maskApiKey(credential.apiKey),
        },
      },
      201,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return jsonResponse(
        { error: "This API key already exists in the database." },
        409,
      );
    }

    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create API credential.",
      },
      500,
    );
  }
}

async function runSolve(
  request: StreamedSolveRequest,
  stream: SseEventStream,
): Promise<void> {
  const logger = new CallbackLogger("solver-api", (entry) => {
    stream.emit("log", entry);
  });

  stream.emit("accepted", {
    title: request.title,
    maxAttempts: request.maxAttempts,
    functionName: request.harness.functionName,
  });

  try {
    const { solveWithFunctionHarness } = await import(
      "./services/solvers/function-harness-solver.js"
    );
    const result = await solveWithFunctionHarness(request, logger);

    stream.emit("result", {
      status: result.status,
      attemptsUsed: result.attemptsUsed,
      finalCandidate: result.finalCandidate,
      finalReport: result.finalReport,
      transcript: result.transcript,
    });
    stream.close();
  } catch (error) {
    stream.error(error);
  }
}

async function runSolveFromText(
  request: RawQuestionRequest,
  stream: SseEventStream,
): Promise<void> {
  const logger = new CallbackLogger("solver-text-api", (entry) => {
    stream.emit("log", entry);
  });

  stream.emit("accepted", {
    title: "raw-question",
    maxAttempts: request.maxAttempts,
  });

  try {
    const { solveRawQuestion } = await import("./services/solvers/raw-question-solver.js");
    const outcome = await solveRawQuestion(request, logger);
    const { blueprint, result } = outcome;
    stream.emit("parsed_problem", blueprint);

    stream.emit("result", {
      status: result.status,
      attemptsUsed: result.attemptsUsed,
      finalCandidate: result.finalCandidate,
      finalReport: result.finalReport,
      transcript: result.transcript,
      blueprint,
    });
    stream.close();
  } catch (error) {
    stream.error(error);
  }
}

async function safeReadJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}***`;
  }

  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Pool observability & admin
// ---------------------------------------------------------------------------

async function handlePoolStats(request: Request): Promise<Response> {
  const secret = process.env.POOL_RESET_SECRET?.trim();
  if (!secret) {
    return jsonResponse(
      { error: "Pool API is disabled. Set POOL_RESET_SECRET to enable it." },
      403,
    );
  }

  const provided = request.headers.get("x-pool-secret");
  if (provided !== secret) {
    return jsonResponse({ error: "Invalid or missing X-Pool-Secret header." }, 401);
  }

  const stats: Record<string, unknown> = {};

  if (isPoolInitialized("openai")) {
    try {
      const pool = await getKeyPool("openai");
      stats.openai = pool.getStats();
    } catch (err) {
      stats.openai = { error: String(err) };
    }
  } else {
    stats.openai = { status: "not initialized" };
  }

  if (isPoolInitialized("gemini")) {
    try {
      const pool = await getKeyPool("gemini");
      stats.gemini = pool.getStats();
    } catch (err) {
      stats.gemini = { error: String(err) };
    }
  } else {
    stats.gemini = { status: "not initialized" };
  }

  return jsonResponse({ ok: true, timestamp: new Date().toISOString(), pools: stats });
}

async function handlePoolReset(request: Request): Promise<Response> {
  // Require a pre-shared secret to prevent accidental or malicious resets.
  // Set POOL_RESET_SECRET in your environment.  If not set, the endpoint is disabled.
  const secret = process.env.POOL_RESET_SECRET?.trim();
  if (!secret) {
    return jsonResponse(
      { error: "Pool reset is disabled. Set POOL_RESET_SECRET to enable it." },
      403,
    );
  }

  const provided = request.headers.get("x-pool-secret");
  if (provided !== secret) {
    return jsonResponse({ error: "Invalid or missing X-Pool-Secret header." }, 401);
  }

  if (isPoolInitialized("openai")) {
    const pool = await getKeyPool("openai").catch(() => null);
    pool?.resetAll();
  }
  
  if (isPoolInitialized("gemini")) {
    const pool = await getKeyPool("gemini").catch(() => null);
    pool?.resetAll();
  }

  // Also tear down singletons so the next request rebuilds them fresh
  // (useful after credential rotation where new env vars were injected).
  await resetPoolSingletons();

  return jsonResponse({ ok: true, message: "All pool slots reset to healthy." });
}
