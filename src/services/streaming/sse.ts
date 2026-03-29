import type { SseEvent } from "../../contracts/http.js";

function encodeSseEvent(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseEventStream {
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();

  readonly stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
    },
    cancel: () => {
      this.controller = undefined;
    },
  });

  emit(type: string, payload: unknown): void {
    if (!this.controller) {
      return;
    }

    this.controller.enqueue(
      this.encoder.encode(
        encodeSseEvent({
          type,
          timestamp: new Date().toISOString(),
          payload,
        }),
      ),
    );
  }

  close(): void {
    this.controller?.close();
    this.controller = undefined;
  }

  error(error: unknown): void {
    this.emit("error", {
      message: error instanceof Error ? error.message : String(error),
    });
    this.close();
  }
}

export function createSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
