import http2 from "node:http2";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";

const {
  NGHTTP2_CANCEL,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;

const TARGET_PORT = 3000;
const PROXY_PORT = 3001;
const proxyHttpsOptions = {
  allowHTTP1: true,
  key: fs.readFileSync("agent1-key.pem"),
  cert: fs.readFileSync("agent1-cert.pem"),
  // NodeJs since Oct 23 has rate limiting for suspected RST attacks
  // See: https://cloud.google.com/blog/products/identity-security/how-it-works-the-novel-http2-rapid-reset-ddos-attack
  // and https://github.com/nodejs/node/pull/50121/files#diff-93eb98470022892511c0a690d96895ce7a994feedfe289ba7cd92423734aa30d
  // This mitigation fix is included in Node since 18.18.2, 20.8.1, 21.0 (around Oct 13 2023)
  // Since we have to resort to server-side streaming and our only way to cancel a streaming call is to abort the connection client-side
  // we have to disable this feature
  streamResetBurst: Number.MAX_SAFE_INTEGER,
  streamResetRate: Number.MAX_SAFE_INTEGER,
};

const proxy = Fastify({
  http2: true,
  https: proxyHttpsOptions,
  exposeHeadRoutes: false,
});
proxy.register(fastifyHttpProxy, {
  disableRequestLogging: true,
  retryMethods: [],
  upstream: `https://localhost:${TARGET_PORT}`, // forward to target server
  http2: { requestTimeout: 0, sessionTimeout: 0 },
  replyOptions: {
    onError(reply, e) {
      const fastifyError = e.error;

      // If the connection was closed by the client, do nothing
      // It doesn't make sense to send a response to a client that has already disconnected
      if (fastifyError.message === "premature close") return;

      // If the upstream server is down, return a 503 (service unavailable) instead of a 502 (bad gateway
      if (fastifyError.statusCode === 502) {
        void reply.code(503).send(fastifyError);
      } else {
        void reply.code(fastifyError.statusCode || 500).send(fastifyError);
      }
    },
    // rewriteHeaders: (headers, request) => ({
    //   ...headers,
    //   ...(headerTemplates && request && interpolateHeaderTemplates(headerTemplates, request)),
    // }),
  },
});

await proxy.listen({ port: PROXY_PORT });
console.log(`proxy server is running on https://localhost:${PROXY_PORT}`);

const server = http2.createSecureServer({
  key: fs.readFileSync("agent1-key.pem"),
  cert: fs.readFileSync("agent1-cert.pem"),
  streamResetBurst: Number.MAX_SAFE_INTEGER,
  streamResetRate: Number.MAX_SAFE_INTEGER,
});

server.on("error", (err) => console.error(err));

server.on("stream", (serverStream, headers, flags) => {
  serverStream.respond({
    [HTTP2_HEADER_CONTENT_TYPE]: "text/html; charset=utf-8",
    [HTTP2_HEADER_STATUS]: 200,
  });

  const sendData = () => {
    const data = `Current Time: ${new Date().toISOString()}\n`;
    if (!serverStream.closed) serverStream.write(data);
  };

  const intervalId = setInterval(sendData, 2);

  // console.log("server stream.id: %o", serverStream.id);

  serverStream.on("aborted", () => {
    // console.error("aborted");
  });

  serverStream.on("error", (err) => {
    console.error("error: %o", err);
  });

  serverStream.on("close", () => {
    // console.log("close");
    clearInterval(intervalId);
  });
});

function makeRequest(client) {
  return new Promise((resolve, reject) => {
    const useAbortController = false;

    // Use AbortController:
    const controller = new AbortController();
    const signal = controller.signal;

    const clientStream = useAbortController
      ? client.request({ [HTTP2_HEADER_PATH]: "/" }, { signal })
      : client.request({ [HTTP2_HEADER_PATH]: "/" });

    // console.log("client stream.id: %o", clientStream.id);

    clientStream.end();

    let counter = 0;
    clientStream.on("response", (headers) => {
      // for (const name in headers) {
      //   console.log(`${name}: ${headers[name]}`);
      // }
    });

    clientStream.on("data", (chunk) => {
      counter += 1;
      // process.stdout.write(chunk);
    });

    clientStream.on("error", (err) => {
      if (err instanceof Error && err.name === "AbortError") {
        resolve();
      } else {
        reject(err);
        console.error(err);
      }
    });

    clientStream.on("end", () => {
      resolve();
    });

    setTimeout(() => {
      // console.log(`Cancelling request after ${counter} messages`);
      if (useAbortController) controller.abort();
      else clientStream.close(NGHTTP2_CANCEL);
    }, 5);
  });
}

server.listen(TARGET_PORT, async () => {
  console.log(`HTTP/2 server is running on https://localhost:${TARGET_PORT}`);

  const client = http2.connect(`https://localhost:${PROXY_PORT}`, {
    rejectUnauthorized: false,
  });
  client.on("error", (err) => console.error(err));
  client.on("close", () => console.log("Session closed"));
  client.on("goaway", (errorCode, lastStreamId) =>
    console.log(` Goaway: ${errorCode}, ${lastStreamId}`)
  );

  for (let i = 1; i <= 10000; i++) {
    process.stdout.write(`\r${i}`);
    await makeRequest(client);
    // comment this line to see the issue:
    // 'Received RST_STREAM with code 2 triggered by internal client error: Session closed with error code 2'
    // after about 1000-1200 iterations
    // await new Promise((resolve) => setTimeout(resolve, 10));
  }

  client.close();
  server.close();
  proxy.close();
});

// run with node pure-http2-proxy.mjs
// or with NODE_DEBUG_NATIVE=TLS,HTTP2 NODE_DEBUG=NET,HTTP2,TLS node pure-http2-proxy.mjs
