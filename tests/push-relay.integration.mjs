import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, connect } from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import { createPushSender, createRelay } from "../pocketbase/push-relay/apns.mjs";

test("APNs HTTP/2 headers, ES256 authentication, environments and error handling", async (t) => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const requests = [], hosts = [];
    let status = 200, reason = "";
    const apns = createServer();
    apns.on("stream", async (stream, headers) => {
        let body = "";
        for await (const chunk of stream) body += chunk;
        requests.push({ headers, body: JSON.parse(body) });
        stream.respond({ ":status": status });
        stream.end(status === 200 ? "" : JSON.stringify({ reason }));
    });
    await new Promise((done) => apns.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => apns.close(done)));
    const send = createPushSender({ teamID: "TESTTEAM", keyID: "TESTKEY", topic: "dev.tkkr.Expenditure",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    }, (host) => {
        hosts.push(host);
        return connect(`http://127.0.0.1:${apns.address().port}`);
    });
    const data = { id: "abcdefghijklmno", token: "ab".repeat(32), environment: "sandbox",
        payload: { aps: { alert: { title: "Trip", body: "Bob added dinner" }, sound: "default" }, type: "circle_expense" },
    };
    assert.equal(await send(data), "sent");
    const { headers, body } = requests[0];
    assert.equal(headers[":path"], `/3/device/${data.token}`);
    assert.equal(headers["apns-topic"], "dev.tkkr.Expenditure");
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(headers["apns-collapse-id"], data.id);
    assert.deepEqual(body, data.payload);
    const jwt = headers.authorization.slice(7).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(jwt[0], "base64url")), { alg: "ES256", kid: "TESTKEY" });
    const claims = JSON.parse(Buffer.from(jwt[1], "base64url"));
    assert.equal(claims.iss, "TESTTEAM");
    assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
    assert.equal(Buffer.from(jwt[2], "base64url").length, 64);
    assert.ok(verify("sha256", Buffer.from(jwt.slice(0, 2).join(".")), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2], "base64url")));
    status = 400;
    reason = "BadDeviceToken";
    assert.equal(await send({ ...data, environment: "production" }), "invalid");
    assert.deepEqual(hosts, ["https://api.sandbox.push.apple.com", "https://api.push.apple.com"]);
    assert.equal(requests[1].headers.authorization, headers.authorization, "Reuse the provider JWT rather than rotating on every send");
    reason = "DeviceTokenNotForTopic";
    assert.equal(await send(data), "retry", "Configuration problems must not erase valid registrations");
    status = 410;
    reason = "Unregistered";
    assert.equal(await send(data), "invalid");
    status = 429;
    reason = "TooManyRequests";
    assert.equal(await send(data), "retry");
    status = 503;
    reason = "Shutdown";
    assert.equal(await send(data), "retry");
});

test("Push relay authenticates and bounds requests without exposing APNs credentials", async (t) => {
    const secret = "relay-test-secret".repeat(3), received = [];
    const server = createRelay({ secret, send: async (data) => {
        received.push(data);
        return "sent";
    } });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(done)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const data = { id: "abcdefghijklmno", token: "ab".repeat(32), environment: "production", payload: { type: "circle_expense", aps: { alert: { title: "Circle", body: "New expense" } } } };
    async function request(body, auth = secret, path = "/send") {
        return fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    }

    assert.equal((await request(data, "wrong")).status, 401);
    assert.equal((await request(data, secret, "/other")).status, 404);
    assert.equal((await request({ ...data, token: "not-a-token" })).status, 400);
    assert.equal((await request({ ...data, environment: "wrong" })).status, 400);
    assert.equal((await request({ ...data, payload: { type: "circle_expense", aps: { alert: "a".repeat(5000) } } })).status, 400);
    const response = await request(data);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "sent" });
    const additional = [];
    for (const type of ["circle_invitation", "circle_repayment", "shortcut_expense", "apns_test"]) {
        const notification = { ...data, payload: { ...data.payload, type } };
        assert.equal((await request(notification)).status, 200);
        additional.push(notification);
    }

    assert.equal((await request({ ...data, payload: { ...data.payload, type: "unsupported" } })).status, 400);
    assert.deepEqual(received, [data, ...additional]);
});
