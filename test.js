/*
 *
 * Copyright 2023 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

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

function bidirectionalStreamingEcho(call) {
  call.on("data", (value) => {
    const message = value.message;
    call.write({ message: message });
  });
  // Either 'end' or 'cancelled' will be emitted when the call is cancelled
  call.on("end", () => {
    call.end();
  });
  call.on("cancelled", () => {
  });
}

const serviceImplementation = {
  bidirectionalStreamingEcho,
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
  return new Promise((resolve, reject) => {
    const call = client.bidirectionalStreamingEcho();
    const EXPECTED_MESSAGES = 5;
    let receivedMessages = 0;
    call.on("data", (value) => {
      receivedMessages += 1;
      if (receivedMessages >= EXPECTED_MESSAGES) {
        call.cancel();
      }
    });
    call.on("status", (status) => {
      if (status.code === grpc.status.OK || status.code === grpc.status.CANCELLED) {
        resolve();
      } else {
        reject(status);
      }
    });
    call.on("error", () => {
      // Ignore error event
    });
    for (let i = 0; i < EXPECTED_MESSAGES; i++) {
      call.write({ message: `hello: ${i.toString()}` });
    }
    call.end();
  });
}

async function main() {
  await startServer();
  const client = new echoProto.Echo(
    "localhost:50052",
    grpc.credentials.createInsecure()
  );
  for (let i = 1; i <= 10000; i++) {
    process.stdout.write(`\r${i}`)
    await callServer(client);
    // remove this line to see the issue: 
    // 'Received RST_STREAM with code 2 triggered by internal client error: Session closed with error code 2'
    // after exactly 1002 iterations
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  console.log("\ndone");
}

await main();
process.exit(0);
