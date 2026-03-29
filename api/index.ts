import { handleHttpRequest } from "../src/app.ts";

export default {
  fetch(request: Request) {
    return handleHttpRequest(rewriteRequestPath(request));
  },
};

function rewriteRequestPath(request: Request): Request {
  const incomingUrl = new URL(request.url);
  const originalPathname = incomingUrl.searchParams.get("__pathname");

  if (!originalPathname) {
    return request;
  }

  const rewrittenUrl = new URL(originalPathname, incomingUrl.origin);
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (key === "__pathname") {
      continue;
    }

    rewrittenUrl.searchParams.append(key, value);
  }

  return new Request(rewrittenUrl.toString(), request);
}
