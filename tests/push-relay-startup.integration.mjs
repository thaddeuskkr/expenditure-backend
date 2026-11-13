import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfiguration, readRelaySecret } from "../pocketbase/push-relay/configuration.mjs";

test("Relay starts from mounted secret files, protects health checks and shuts down cleanly", { timeout: 20000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "expenditure-relay-startup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyPath = join(directory, "apns.p8"), secretPath = join(directory, "relay-secret");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o400 });
    const secret = randomBytes(32).toString("hex");
    await writeFile(secretPath, secret + "\n", { mode: 0o400 });
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const environment = {
        ...process.env, HOST: "127.0.0.1", PORT: String(port), APNS_TEAM_ID: "TESTTEAM", APNS_KEY_ID: "TESTKEY",
        APNS_TOPIC: "dev.tkkr.Expenditure", APNS_KEY_PATH: keyPath,
        EXPENDITURE_PUSH_RELAY_SECRET: "", EXPENDITURE_PUSH_RELAY_SECRET_FILE: secretPath,
    };
    const child = spawn(process.execPath, [resolve("pocketbase/push-relay/server.mjs")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stdout.on("data", (chunk) => {
        logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
        logs += chunk;
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${secret}` };
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            if ((await fetch(base + "/healthz", { headers })).ok) break;
        } catch {}

        if (child.exitCode !== null || attempt === 99) assert.fail(logs);
        await new Promise((done) => setTimeout(done, 25));
    }

    assert.equal((await fetch(base + "/healthz")).status, 401);
    const health = await fetch(base + "/healthz", { headers });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal((await fetch(base + "/send", { method: "POST", headers, body: "{}" })).status, 400);
    assert.equal((await fetch(base + "/send", { method: "POST", body: "{}" })).status, 401);
    const check = spawnSync(process.execPath, [resolve("pocketbase/push-relay/healthcheck.mjs")], { env: environment, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    const wrongPath = join(directory, "wrong-secret");
    await writeFile(wrongPath, randomBytes(32).toString("hex"), { mode: 0o400 });
    const failed = spawnSync(process.execPath, [resolve("pocketbase/push-relay/healthcheck.mjs")], {
        env: { ...environment, EXPENDITURE_PUSH_RELAY_SECRET_FILE: wrongPath }, encoding: "utf8",
    });
    assert.equal(failed.status, 1, "Health checks must authenticate using the mounted secret");
    const exited = new Promise((done) => child.once("exit", (code) => done(code)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0, logs);
});

test("Relay configuration rejects ambiguous secrets and invalid ports", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "expenditure-relay-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "secret");
    await writeFile(path, "x".repeat(64) + "\n", { mode: 0o400 });
    assert.equal(readRelaySecret({ EXPENDITURE_PUSH_RELAY_SECRET_FILE: path }).length, 64);
    assert.equal(readRelaySecret({ EXPENDITURE_PUSH_RELAY_SECRET: "x".repeat(32) }).length, 32);
    assert.throws(() => readRelaySecret({ EXPENDITURE_PUSH_RELAY_SECRET: "short" }), /at least 32/);
    assert.throws(() => readRelaySecret({ EXPENDITURE_PUSH_RELAY_SECRET_FILE: path, EXPENDITURE_PUSH_RELAY_SECRET: "x".repeat(64) }), /only one/);
    const base = { APNS_TEAM_ID: "TEAM", APNS_KEY_ID: "KEY", APNS_KEY_PATH: path, APNS_TOPIC: "topic", EXPENDITURE_PUSH_RELAY_SECRET_FILE: path };
    for (const port of ["0", "-1", "65536", "abc", "8091.5"]) assert.throws(() => readConfiguration({ ...base, PORT: port }), /PORT/);
});
