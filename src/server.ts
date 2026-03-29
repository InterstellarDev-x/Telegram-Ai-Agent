import { handleHttpRequest } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  idleTimeout: 255,
  fetch(request) {
    return handleHttpRequest(request);
  },
});

console.log(
  JSON.stringify({
    message: "server-started",
    port: server.port,
    date: new Date().toISOString(),
  }),
);
