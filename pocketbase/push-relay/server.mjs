import { createPushSender, createRelay } from "./apns.mjs";
import { readConfiguration } from "./configuration.mjs";

const configuration = readConfiguration();
const send = createPushSender(configuration);
const server = createRelay({ secret: configuration.secret, send });
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(configuration.port, configuration.host, () => {
    console.log("Expenditure APNs relay listening");
});

function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => {
        server.closeAllConnections();
        process.exit(1);
    }, 15000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
