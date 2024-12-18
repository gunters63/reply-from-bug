import http2 from "node:http2";

const {
  NGHTTP2_CANCEL,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;

const server = http2.createServer();
server.on("error", (err) => console.error(err));

server.on("stream", (stream, headers) => {
  stream.respond({
    [HTTP2_HEADER_CONTENT_TYPE]: "text/html; charset=utf-8",
    [HTTP2_HEADER_STATUS]: 200,
  });

  const sendData = () => {
    const data = `Current Time: ${new Date().toISOString()}\n`;
    stream.write(data);
  };

  const intervalId = setInterval(sendData, 2);

  stream.on("close", () => {
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

    const req = useAbortController
      ? client.request({ [HTTP2_HEADER_PATH]: "/" }, { signal })
      : client.request({ [HTTP2_HEADER_PATH]: "/" });

    req.end();

    let counter = 0;
    req.on("response", (headers) => {
      // for (const name in headers) {
      //   console.log(`${name}: ${headers[name]}`);
      // }

      req.on("data", (chunk) => {
        counter += 1;
        // process.stdout.write(chunk);
      });

      req.on("error", (err) => {
        if (err instanceof Error && err.name === "AbortError") {
          resolve();
        } else {
          reject(err);
          console.error(err);
        }
      });

      req.on("end", () => {
        resolve();
      });

      setTimeout(() => {
        // console.log(`Cancelling request after ${counter} messages`);
        if (useAbortController) controller.abort();
        else req.close(NGHTTP2_CANCEL);
      }, 5);
    });
  });
}

const PORT = 3000;
server.listen(PORT, async () => {
  console.log(`HTTP/2 server is running on http://localhost:${PORT}`);

  const client = http2.connect(`http://localhost:${PORT}`);
  client.on("error", (err) => console.error(err));
  client.on("close", () => console.log("Session closed"));
  client.on("goaway", (errorCode, lastStreamId) =>
    console.log(`Goaway: ${errorCode}, ${lastStreamId}`)
  );

  for (let i = 1; i <= 10000; i++) {
    process.stdout.write(`\r${i}`);
    await makeRequest(client);
    // comment this line to see the issue:
    // 'Received RST_STREAM with code 2 triggered by internal client error: Session closed with error code 2'
    // after about 1200 iterations
    // await new Promise((resolve) => setTimeout(resolve, 10));
  }

  client.close();
  server.close();
});
