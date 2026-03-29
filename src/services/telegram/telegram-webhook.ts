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
        "I am already processing your previous batch of images.",
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

    const rawQuestionRequest = await buildRawQuestionRequestFromImages(
      session.images,
      workflowLogger.child("ingress"),
      client,
    );

    await workflow.send(
      "Question received. Parsing the problem and preparing the verification harness.",
    );

    const outcome = await solveRawQuestion(rawQuestionRequest, workflowLogger.child("solver"));

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
): Promise<RawQuestionRequest> {
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

  const question = combineExtractedProblemText(extractedSegments);
  if (question.length < 40) {
    throw new UnclearImagesError(
      "The extracted text was too short to reconstruct the full coding problem.",
    );
  }

  return {
    question,
    targetLanguage: "cpp",
    maxAttempts: 4,
    imageAssets,
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
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const segment of extractedSegments) {
    const normalized = segment.questionText.trim();
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    parts.push(normalized);
  }

  return parts.join("\n\n");
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
    case "generation-started":
      return `Generating solution candidate${attempt ? ` (attempt ${attempt})` : ""}.`;
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
