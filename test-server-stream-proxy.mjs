import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";

const __dirname = import.meta.dirname;
const PROTO_PATH = __dirname + "/protos/echo.proto";
const TARGET_PORT = 3000;
const PROXY_PORT = 3001;

const key = fs.readFileSync("agent1-key.pem");
const cert = fs.readFileSync("agent1-cert.pem");

const proxyHttpsOptions = {
  allowHTTP1: true,
  key,
  cert,
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
  http2: { requestTimeout: 0, sessionTimeout: 0 }
});

await proxy.listen({ port: PROXY_PORT });
console.log(`proxy server is running on https://localhost:${PROXY_PORT}`);

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const echoProto =
  grpc.loadPackageDefinition(packageDefinition).grpc.examples.echo;

function serverStreamingEcho(call) {
  const timer = setInterval(() => {
    call.write({ message: "hello" });
  }, 1);
  call.on("end", () => {
    // console.log("end");
    clearInterval(timer);
    call.end();
  });
  call.on("cancelled", () => {
    // console.log("cancelled");
    clearInterval(timer);
  });
}

const serviceImplementation = {
  serverStreamingEcho,
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(echoProto.Echo.service, serviceImplementation);
    server.bindAsync(
      `localhost:${TARGET_PORT}`,
      grpc.ServerCredentials.createSsl(null, [
        { private_key: key, cert_chain: cert },
      ]),
      (error, p) => {
        if (error) {
          console.error(error, "could not start server");
          reject(error);
        } else {
          console.log(`grpc target server listening on ${p}`);
          resolve();
        }
      }
    );
  });
}

function callServer(client) {
  const promise = new Promise((resolve, reject) => {
    const call = client.serverStreamingEcho({ message: "hello" });
    let receivedMessages = 0;
    call.on("data", (value) => {
      receivedMessages += 1;
    });
    call.on("status", (status) => {
      if (
        status.code === grpc.status.OK ||
        status.code === grpc.status.CANCELLED
      ) {
        resolve();
      } else {
        reject(status);
      }
    });
    call.on("error", (err) => {
      if (err.code !== grpc.status.CANCELLED) console.error("error", err);
    });
    setTimeout(() => {
      // console.log("cancelling call, %d messages received", receivedMessages);
      call.cancel();
    }, 10);
  });
  return promise;
}

async function main() {
  await startServer();
  const client = new echoProto.Echo(
    `localhost:${TARGET_PORT}`,
    grpc.credentials.createInsecure()
  );
  for (let i = 1; i <= 10000; i++) {
    process.stdout.write(`\r${i}`);
    await callServer(client);
    // comment this line to see the issue:
    // 'Received RST_STREAM with code 2 triggered by internal client error: Session closed with error code 2'
    // after about 1500 iterations
    // await new Promise((resolve) => setTimeout(resolve, 5));
  }
  console.log("\ndone");
}

await main();
process.exit(0);

// run with node test-server-stream-proxy.mjs
// or with NODE_DEBUG_NATIVE=TLS,HTTP2 NODE_DEBUG=NET,HTTP2,TLS node test-server-stream-proxy.mjs
