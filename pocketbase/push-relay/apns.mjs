import { createPrivateKey, sign, timingSafeEqual } from "node:crypto";
import { connect } from "node:http2";
import { createServer } from "node:http";

export function createPushSender({ teamID, keyID, privateKey, topic }, openConnection = connect) {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1")
        throw new Error("APNs requires a P-256 signing key.");
    let cachedToken, issuedAt = 0;
    function authorization() {
        const now = Math.floor(Date.now() / 1000);
        if (!cachedToken || now - issuedAt >= 3000) {
            const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyID })).toString("base64url");
            const claims = Buffer.from(JSON.stringify({ iss: teamID, iat: now })).toString("base64url");
            const unsigned = `${header}.${claims}`;
            cachedToken = `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
            issuedAt = now;
        }

        return `bearer ${cachedToken}`;
    }

    return async ({ id, token, environment, payload }) => {
        const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
        return new Promise((resolve) => {
            const session = openConnection(host);
            let done = false;
            const finish = (result) => {
                if (done) return;
                done = true;
                clearTimeout(deadline);
                session.destroy();
                resolve(result);
            };

            const deadline = setTimeout(() => finish("retry"), 10000);
            session.on("error", () => finish("retry"));
            session.on("connect", () => {
                let request;
                try {
                    request = session.request({
                        ":method": "POST", ":path": `/3/device/${token}`,
                        authorization: authorization(), "apns-topic": topic,
                        "apns-push-type": "alert", "apns-priority": "10",
                        "apns-collapse-id": id,
                        "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
                    });
                } catch {
                    finish("retry");
                    return;
                }

                let status, body = "";
                request.setEncoding("utf8");
                request.on("response", (headers) => {
                    status = headers[":status"];
                });
                request.on("data", (chunk) => {
                    body += chunk;
                    if (body.length > 4096) finish("retry");
                });
                request.on("error", () => finish("retry"));
                request.on("end", () => {
                    if (status === 200) {
                        finish("sent");
                        return;
                    }

                    let reason;
                    try {
                        reason = JSON.parse(body).reason;
                    } catch { /* Retry an unreadable response. */ }

                    // Topic/key/configuration failures must not delete valid tokens.
                    finish(status === 410 || (status === 400 && reason === "BadDeviceToken") ? "invalid" : "retry");
                });
                request.end(JSON.stringify(payload));
            });
        });
    };
}

export function createRelay({ secret, send }) {
    if (typeof secret !== "string" || secret.length < 32) throw new Error("Use a relay secret of at least 32 characters.");
    const expected = Buffer.from(`Bearer ${secret}`);
    return createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        function reply(status, data) {
            response.writeHead(status);
            response.end(JSON.stringify(data));
        }

        const supplied = Buffer.from(request.headers.authorization ?? "");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            request.resume();
            reply(401, { error: "Unauthorized" });
            return;
        }

        if (request.method === "GET" && request.url === "/healthz") {
            request.resume();
            reply(200, { status: "ok" });
            return;
        }

        if (request.method !== "POST" || request.url !== "/send") {
            request.resume();
            reply(404, { error: "Not found" });
            return;
        }

        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 8192) {
                    reply(413, { error: "Payload too large" });
                    return;
                }

                chunks.push(chunk);
            }

            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!/^[a-z0-9]{15}$/.test(data.id) || typeof data.token !== "string" ||
                !/^(?:[a-f0-9]{2}){16,256}$/.test(data.token) || !["sandbox", "production"].includes(data.environment) ||
                !["circle_expense", "circle_invitation", "circle_repayment", "shortcut_expense", "apns_test"].includes(data.payload?.type) || !data.payload.aps?.alert ||
                Buffer.byteLength(JSON.stringify(data.payload)) > 4096) {
                reply(400, { error: "Invalid notification" });
                return;
            }

            reply(200, { result: await send(data) });
        } catch {
            reply(503, { result: "retry" });
        }
    });
}
