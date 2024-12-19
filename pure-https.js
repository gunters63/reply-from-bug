import http2 from "node:http2";
import https from "node:https";
import fs from 'node:fs';

const {
  NGHTTP2_CANCEL,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;

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
    serverStream.write(data);
  };

  const intervalId = setInterval(sendData, 1);

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
    }, 3);
  });
}

const PORT = 3000;
server.listen(PORT, async () => {
  console.log(`HTTP/2 server is running on https://localhost:${PORT}`);

  const client = http2.connect(`https://localhost:${PORT}`, {
    rejectUnauthorized: false
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
});

// run with node pure-http2.js
// or with NODE_DEBUG_NATIVE=* NODE_DEBUG=* node pure-http2.js
