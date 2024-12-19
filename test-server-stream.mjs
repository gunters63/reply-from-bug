import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const __dirname = import.meta.dirname;
const PROTO_PATH = __dirname + "/protos/echo.proto";

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
    const port = 50052;
    const server = new grpc.Server();
    server.addService(echoProto.Echo.service, serviceImplementation);
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, p) => {
        if (error) {
          console.error(error, "could not start server");
          reject(error);
        } else {
          console.log(`server listening on ${p}`);
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
    call.on("error", () => {
      // Ignore error event
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
    "localhost:50052",
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
