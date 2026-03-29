import type { RawQuestionRequest } from "../../contracts/http.js";
import {
  telegramUpdateSchema,
  type TelegramMessage,
  type TelegramPhotoSize,
  type TelegramUpdate,
} from "../../contracts/telegram.js";
import { solveRawQuestion } from "../solvers/raw-question-solver.js";
import {
  ProblemImageExtractor,
  type ProblemImageExtractionResult,
} from "../vision/problem-image-extractor.js";
import type { ProblemImageAsset } from "../../contracts/problem.js";
import { CallbackLogger, type LogEntry, type Logger } from "../../utils/logger.js";
import { solveArtifactStore } from "../storage/solve-artifact-store.js";
import {
  createTelegramBotClient,
  type TelegramBotClient,
} from "./telegram-bot-client.js";
import {
  telegramSessionStore,
  type PendingTelegramImage,
} from "./telegram-session-store.js";

export async function validateTelegramWebhookRequest(
  request: Request,
): Promise<TelegramUpdate> {
  verifyTelegramWebhookSecret(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("Invalid Telegram webhook JSON payload.");
  }

  return telegramUpdateSchema.parse(body);
}

export async function processTelegramUpdate(
  update: TelegramUpdate,
  logger: Logger,
): Promise<void> {
  const message = update.message ?? update.edited_message;

  if (!message) {
    logger.info("telegram-update-ignored", {
      updateId: update.update_id,
      reason: "no-message",
    });
    return;
  }

  const client = createTelegramBotClient(logger);
  const chatId = message.chat.id;
  const text = message.text?.trim();
  const session = await telegramSessionStore.get(chatId);

  if (text === "1") {
    await telegramSessionStore.startCollecting(chatId);
    await client.sendTextMessage(
      chatId,
      "Image collection started. Send images of the coding problem now. When you are done, send 2 and I will start processing.",
      { replyToMessageId: message.message_id },
    );
    return;
  }

  if (text === "2") {
    if (session.mode === "processing") {
      await client.sendTextMessage(
        chatId,
        "Your previous solve is still running. Please wait for it to finish instead of sending 2 again.",
        { replyToMessageId: message.message_id },
      );
      return;
    }

    if (session.images.length === 0) {
      await client.sendTextMessage(
        chatId,
        "No images are queued. Send 1 to start, upload your problem images, then send 2.",
        { replyToMessageId: message.message_id },
      );
      return;
    }

    await telegramSessionStore.startProcessing(chatId);
    await processCollectedImages(update, message, client, logger);
    return;
  }

  const pendingImage = buildPendingImage(message);
  if (pendingImage) {
    if (session.mode !== "collecting") {
      await client.sendTextMessage(
        chatId,
        "Send 1 first so I know to start collecting images. After uploading all images, send 2 to process them.",
        { replyToMessageId: message.message_id },
      );
      return;
    }

    const updated = await telegramSessionStore.addImage(chatId, pendingImage);
    await client.sendTextMessage(
      chatId,
      `Image ${updated.images.length} saved. Send more images, or send 2 to start processing.`,
      { replyToMessageId: message.message_id },
    );
    return;
  }

  if (session.mode === "collecting") {
    await client.sendTextMessage(
      chatId,
      "I am currently collecting images. Send images now, or send 2 when you want me to process the queued images.",
      { replyToMessageId: message.message_id },
    );
    return;
  }

  if (text) {
    await client.sendTextMessage(
      chatId,
      "Send 1 to start collecting problem images. Then send images. After uploading them, send 2 and I will extract, solve, and verify the code.",
      { replyToMessageId: message.message_id },
    );
    return;
  }

  await client.sendTextMessage(
    chatId,
    "Send 1 to start collecting problem images.",
    { replyToMessageId: message.message_id },
  );
}

async function processCollectedImages(
  update: TelegramUpdate,
  message: TelegramMessage,
  client: TelegramBotClient,
  logger: Logger,
): Promise<void> {
  const chatId = message.chat.id;
  const session = await telegramSessionStore.get(chatId);
  const artifactId = crypto.randomUUID();
  const workflow = createTelegramWorkflowMessenger(client, chatId, message.message_id);
  const workflowLogger = new CallbackLogger("telegram-workflow", (entry) => {
    console.log(JSON.stringify(entry));
    workflow.onLog(entry);
  });

  try {
    await client.sendChatAction(chatId, "typing");
    await workflow.send(
      `Processing ${session.images.length} queued image(s). Extracting the coding problem first.`,
    );

    const rawQuestionPayload = await buildRawQuestionRequestFromImages(
      session.images,
      workflowLogger.child("ingress"),
      client,
      artifactId,
    );
    const rawQuestionRequest = rawQuestionPayload.request;

    await solveArtifactStore.put({
      id: artifactId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage: "ingested",
      chatId,
      targetLanguage: rawQuestionRequest.targetLanguage,
      extraction: {
        imageCount: session.images.length,
        warnings: rawQuestionPayload.warnings,
        segmentKinds: rawQuestionPayload.segmentKinds,
        normalizedQuestion: rawQuestionRequest.question,
      },
    });

    await workflow.send(
      "Question received. Parsing the problem and preparing the verification harness.",
    );

    const outcome = await solveRawQuestion(rawQuestionRequest, workflowLogger.child("solver"));

    await solveArtifactStore.patch(artifactId, {
      stage: outcome.result.status === "passed" ? "solved" : "failed",
      title: outcome.blueprint.title,
      parse: {
        detectedStyle: outcome.blueprint.detectedStyle,
        notes: outcome.blueprint.notes,
        alternateSolveRequests: outcome.blueprint.alternateSolveRequests.length,
      },
      solve: {
        status: outcome.result.status,
        attemptsUsed: outcome.result.attemptsUsed,
        providers: outcome.result.transcript
          .filter((entry) => entry.type === "generation.response")
          .map((entry) =>
            typeof entry.payload === "object" &&
            entry.payload &&
            "provider" in entry.payload &&
            typeof entry.payload.provider === "string"
              ? entry.payload.provider
              : "unknown",
          ),
        verdict: outcome.result.finalReport.verdict,
      },
    });

    if (outcome.result.status !== "passed" || !outcome.result.finalCandidate) {
      throw new Error("The solver could not verify a final solution.");
    }

    await workflow.send(
      `Verified solution for ${outcome.blueprint.title} in ${outcome.result.attemptsUsed} attempt(s).`,
    );
    await client.sendCodeMessage(
      chatId,
      outcome.result.finalCandidate.code,
      outcome.result.finalCandidate.language,
      undefined,
      message.message_id,
    );
    await telegramSessionStore.reset(chatId);
  } catch (error) {
    logger.error("telegram-update-failed", {
      updateId: update.update_id,
      reason: error instanceof Error ? error.message : "unknown-error",
      chatId,
      artifactId,
    });

    await solveArtifactStore.patch(artifactId, {
      stage: "failed",
    });

    if (error instanceof UnclearImagesError) {
      await telegramSessionStore.resetToCollecting(chatId);
      await client.sendTextMessage(
        chatId,
        `The uploaded images were not clear enough to extract the full problem reliably.\n\n${error.message}\n\nPlease send clearer screenshots or photos, then send 2 again.`,
        { replyToMessageId: message.message_id },
      );
      return;
    }

    await telegramSessionStore.reset(chatId);
    await client.sendTextMessage(chatId, buildFailureMessage(error), {
      replyToMessageId: message.message_id,
    });
  }
}

async function buildRawQuestionRequestFromImages(
  images: PendingTelegramImage[],
  logger: Logger,
  client: TelegramBotClient,
  artifactId: string,
): Promise<{
  request: RawQuestionRequest;
  warnings: string[];
  segmentKinds: string[];
}> {
  const extractor = new ProblemImageExtractor(logger.child("image-extractor"));
  const extractedSegments: ProblemImageExtractionResult[] = [];
  const imageAssets: ProblemImageAsset[] = [];

  for (const [index, image] of images.entries()) {
    logger.info("telegram-image-processing-progress", {
      index: index + 1,
      total: images.length,
    });
    logger.info("telegram-image-processing-started", {
      index: index + 1,
      total: images.length,
      source: image.source,
    });

    const file = await client.getFile(image.fileId);
    const imageBytes = await client.downloadFile(file.file_path ?? "");
    const mimeType = inferImageMimeType(file.file_path, image.mimeType);
    const extraction = await extractor.extractQuestion({
      imageBytes,
      mimeType,
      caption: image.caption,
    });

    extractedSegments.push(extraction);
    imageAssets.push({
      mimeType,
      dataUrl: buildDataUrl(imageBytes, mimeType),
      caption: image.caption,
    });
    logger.info("telegram-image-processing-finished", {
      index: index + 1,
      total: images.length,
      readability: extraction.readability,
      coverage: extraction.coverage,
    });
  }

  const unclearSegments = extractedSegments.filter(
    (segment) =>
      segment.readability === "unclear" || segment.questionText.trim().length < 20,
  );

  if (unclearSegments.length > 0) {
    const reasons = unclearSegments
      .flatMap((segment) => segment.issues)
      .filter(Boolean)
      .slice(0, 3);

    throw new UnclearImagesError(
      reasons.length > 0
        ? reasons.join("\n")
        : "Some images were blurry, cropped, or unreadable.",
    );
  }

  const warnings = extractImageWarnings(extractedSegments);
  const question = combineExtractedProblemText(extractedSegments);
  logger.info("image-segments-normalized", {
    imageCount: images.length,
    segmentKinds: extractedSegments.map((segment) => segment.imageKind),
    warningCount: warnings.length,
  });
  if (question.length < 40) {
    throw new UnclearImagesError(
      "The extracted text was too short to reconstruct the full coding problem.",
    );
  }

  return {
    request: {
      question,
      targetLanguage: "cpp",
      maxAttempts: 4,
      imageAssets,
      extractionWarnings: warnings,
      artifactId,
    },
    warnings,
    segmentKinds: extractedSegments.map((segment) => segment.imageKind),
  };
}

function verifyTelegramWebhookSecret(request: Request): void {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (!expected) {
    return;
  }

  const actual = request.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (actual !== expected) {
    throw new Error("Invalid Telegram webhook secret.");
  }
}

function pickLargestPhoto(photos?: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  if (!photos || photos.length === 0) {
    return undefined;
  }

  return [...photos].sort((left, right) => {
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return rightArea - leftArea;
  })[0];
}

function isImageDocument(mimeType?: string): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function buildPendingImage(message: TelegramMessage): PendingTelegramImage | null {
  const photo = pickLargestPhoto(message.photo);
  if (photo) {
    return {
      fileId: photo.file_id,
      source: "photo",
      caption: message.caption,
      receivedAt: new Date().toISOString(),
    };
  }

  if (message.document && isImageDocument(message.document.mime_type)) {
    return {
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      source: "document",
      caption: message.caption,
      receivedAt: new Date().toISOString(),
    };
  }

  return null;
}

function combineExtractedProblemText(
  extractedSegments: ProblemImageExtractionResult[],
): string {
  const seenBlocks = new Set<string>();
  const statementParts: string[] = [];
  const templateParts: string[] = [];

  const orderedSegments = [...extractedSegments].sort((left, right) => {
    return rankImageKind(left.imageKind) - rankImageKind(right.imageKind);
  });

  for (const segment of orderedSegments) {
    const normalizedQuestion = normalizeExtractedBlock(segment.questionText);
    const normalizedTemplate = normalizeExtractedBlock(segment.starterTemplateText);

    if (normalizedQuestion) {
      pushUniqueMergedBlock(statementParts, seenBlocks, normalizedQuestion);
    }

    if (normalizedTemplate) {
      pushUniqueMergedBlock(templateParts, seenBlocks, normalizedTemplate);
    }
  }

  const mergedStatement = statementParts.join("\n\n").trim();
  const mergedTemplate = templateParts.join("\n\n").trim();
  if (!mergedTemplate) {
    return mergedStatement;
  }

  return `${mergedStatement}\n\nStarter Template:\n${mergedTemplate}`.trim();
}

function inferImageMimeType(filePath?: string, fallback?: string): string {
  if (fallback) {
    return fallback;
  }

  if (filePath?.endsWith(".png")) {
    return "image/png";
  }

  if (filePath?.endsWith(".webp")) {
    return "image/webp";
  }

  return "image/jpeg";
}

function buildDataUrl(imageBytes: Uint8Array, mimeType: string): string {
  const base64 = Buffer.from(imageBytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

function buildFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : "Unknown error";
  return `I could not verify a final solution.\n\nReason: ${reason}`;
}

class UnclearImagesError extends Error {}

function createTelegramWorkflowMessenger(
  client: TelegramBotClient,
  chatId: number,
  replyToMessageId: number,
): {
  send(text: string): Promise<void>;
  onLog(entry: LogEntry): void;
} {
  let queue = Promise.resolve();
  const seen = new Set<string>();

  const enqueue = (text: string): Promise<void> => {
    queue = queue
      .then(() =>
        client.sendTextMessage(chatId, text, {
          replyToMessageId,
        }),
      )
      .catch(() => undefined);

    return queue;
  };

  return {
    send(text: string) {
      return enqueue(text);
    },
    onLog(entry: LogEntry) {
      const notification = mapLogEntryToTelegramMessage(entry);
      if (!notification) {
        return;
      }

      if (seen.has(notification)) {
        return;
      }

      seen.add(notification);
      void enqueue(notification);
    },
  };
}

function mapLogEntryToTelegramMessage(entry: LogEntry): string | null {
  const attempt =
    typeof entry.data?.attempt === "number" ? entry.data.attempt : undefined;

  switch (entry.message) {
    case "telegram-image-processing-progress":
      if (
        typeof entry.data?.index === "number" &&
        typeof entry.data?.total === "number"
      ) {
        return `Reading image ${entry.data.index} of ${entry.data.total}.`;
      }
      return "Reading the uploaded image.";
    case "parser-template-selected":
      return "Recognized the problem format and built a deterministic solve request.";
    case "parser-agent-started":
      return "Parsing the extracted text into structured problem JSON.";
    case "image-segments-normalized":
      return "Merged the extracted screenshots into one normalized problem packet.";
    case "generation-candidates-ready":
      if (Array.isArray(entry.data?.providers) && entry.data.providers.length > 0) {
        return `Candidate sources: ${entry.data.providers.join(", ")}.`;
      }
      return null;
    case "generation-started":
      return `Generating solution candidate${attempt ? ` (attempt ${attempt})` : ""}.`;
    case "deterministic-verification-failed":
      return `Rejected a candidate before full verification${attempt ? ` on attempt ${attempt}` : ""}.`;
    case "testing-started":
      return `Running verifier tests${attempt ? ` for attempt ${attempt}` : ""}.`;
    case "testing-failed":
      return `Verification failed${attempt ? ` on attempt ${attempt}` : ""}. Retrying with tester feedback.`;
    case "testing-passed":
      return "Verification passed.";
    case "workflow-passed":
      return "Supervisor accepted the verified solution.";
    case "workflow-failed":
      return "Supervisor exhausted the retry budget without a verified answer.";
    case "telegram-image-processing-finished":
      return "Finished extracting text from one image.";
    default:
      return null;
  }
}

function extractImageWarnings(
  extractedSegments: ProblemImageExtractionResult[],
): string[] {
  return Array.from(
    new Set(
      extractedSegments
        .flatMap((segment) => segment.issues)
        .map((issue) => issue.trim())
        .filter(Boolean),
    ),
  );
}

function rankImageKind(kind: ProblemImageExtractionResult["imageKind"]): number {
  switch (kind) {
    case "statement":
      return 0;
    case "mixed":
      return 1;
    case "template":
      return 2;
    default:
      return 3;
  }
}

function pushUniqueMergedBlock(
  blocks: string[],
  seenBlocks: Set<string>,
  nextBlock: string,
): void {
  const key = nextBlock.replace(/\s+/g, " ").toLowerCase();
  if (seenBlocks.has(key)) {
    return;
  }

  const previous = blocks[blocks.length - 1];
  if (previous) {
    const merged = mergeOverlappingBlocks(previous, nextBlock);
    if (merged !== null) {
      seenBlocks.delete(previous.replace(/\s+/g, " ").toLowerCase());
      blocks[blocks.length - 1] = merged;
      seenBlocks.add(merged.replace(/\s+/g, " ").toLowerCase());
      return;
    }
  }

  blocks.push(nextBlock);
  seenBlocks.add(key);
}

function mergeOverlappingBlocks(left: string, right: string): string | null {
  if (!left || !right) {
    return null;
  }

  if (left.includes(right)) {
    return left;
  }

  if (right.includes(left)) {
    return right;
  }

  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const maxOverlap = Math.min(leftLines.length, rightLines.length, 12);

  for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
    const leftSuffix = leftLines.slice(-overlap).join("\n").trim().toLowerCase();
    const rightPrefix = rightLines.slice(0, overlap).join("\n").trim().toLowerCase();
    if (leftSuffix && leftSuffix === rightPrefix) {
      return [...leftLines, ...rightLines.slice(overlap)].join("\n").trim();
    }
  }

  return null;
}

function normalizeExtractedBlock(text: string): string {
  return text
    .replace(/\u0000rst\b/gi, "first")
    .replace(/\u0000nal\b/gi, "final")
    .replace(/\u0000/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\b10\s*\^\s*(\d+)\b/g, "10^$1")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}
