import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { handleHttpRequest } from "../src/app.ts";

export default async function handler(
  req: IncomingMessage & { url?: string; method?: string; headers: IncomingHttpHeaders },
  res: ServerResponse,
): Promise<void> {
  const request = await toWebRequest(req);
  const response = await handleHttpRequest(request);
  await sendNodeResponse(res, response);
}

async function toWebRequest(
  req: IncomingMessage & { url?: string; method?: string; headers: IncomingHttpHeaders },
): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const protocol = getForwardedProtocol(req.headers);
  const incomingUrl = new URL(req.url ?? "/", `${protocol}://${host}`);
  const originalPathname = incomingUrl.searchParams.get("__pathname");
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  const pathname = originalPathname ?? incomingUrl.pathname;
  const url = new URL(pathname, `${protocol}://${host}`);
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (key === "__pathname") {
      continue;
    }

    url.searchParams.append(key, value);
  }

  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? undefined : await readNodeBody(req);

  return new Request(url.toString(), {
    method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  });
}

async function sendNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function readNodeBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function getForwardedProtocol(headers: IncomingHttpHeaders): string {
  const forwarded = headers["x-forwarded-proto"];

  if (Array.isArray(forwarded)) {
    return forwarded[0] ?? "https";
  }

  return forwarded ?? "https";
}
