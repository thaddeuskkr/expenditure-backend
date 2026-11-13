import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

test(
    "PocketBase migrations, user isolation, scoped API keys, and aggregation",
    { timeout: 60000 },
    async (t) => {
        const binary = process.env.POCKETBASE_BINARY;
        assert.ok(
            binary,
            "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable. This test uses a disposable local database.",
        );
        const directory = await mkdtemp(join(tmpdir(), "expenditure-test-"));
        const listener = createServer();
        await new Promise((done) => listener.listen(0, "127.0.0.1", done));
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const base = `http://127.0.0.1:${port}`;
        const flags = [
            `--dir=${directory}`,
            `--hooksDir=${resolve("pocketbase/pb_hooks")}`,
            `--migrationsDir=${resolve("pocketbase/pb_migrations")}`,
        ];
        const password = randomBytes(24).toString("hex");
        const setup = spawnSync(
            binary,
            ["superuser", "upsert", "test@example.com", password, ...flags],
            { encoding: "utf8" },
        );
        assert.equal(setup.status, 0, setup.stderr);
        let fxRequests = 0,
            fxStatus = 200;
        const rateDate = new Date().toISOString().slice(0, 10);
        const fxServer = createHttpServer((req, res) => {
            fxRequests++;
            res.writeHead(fxStatus, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify(
                    [
                        ["USD", 1.2],
                        ["SGD", 1.5],
                        ["JPY", 150],
                        ["KWD", 0.3],
                    ].map(([quote, rate]) => ({
                        base: "EUR",
                        quote,
                        rate,
                        date: rateDate,
                    })),
                ),
            );
        });
        await new Promise((done) => fxServer.listen(0, "127.0.0.1", done));
        t.after(() => new Promise((done) => {
            fxServer.closeAllConnections();
            fxServer.close(done);
        }));
        const fxUrl = `http://127.0.0.1:${fxServer.address().port}/rates`;
        const server = spawn(
            binary,
            ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags],
            {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, EXPENDITURE_FX_URL: fxUrl },
            },
        );
        let logs = "";
        server.stdout.on("data", (chunk) => {
            logs += chunk;
        });
        server.stderr.on("data", (chunk) => {
            logs += chunk;
        });
        t.after(async () => {
            if (server.exitCode === null && server.signalCode === null) {
                const exited = new Promise((done) => server.once("exit", done));
                server.kill("SIGTERM");
                await exited;
            }

            await rm(directory, { recursive: true, force: true });
        });
        async function request(
            path,
            { token, key, method = "GET", body, headers = {} } = {},
        ) {
            ({ path, body } = await resolveCategoryFixture(base, path, body, token));
            const response = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { Authorization: token } : {}),
                    ...(key ? { "X-API-Key": key } : {}),
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    ...headers,
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            return { status: response.status, data: text ? JSON.parse(text) : null };
        }

        for (let i = 0; i < 100; i++) {
            try {
                if ((await request("/api/health")).status === 200) break;
            } catch {}

            await new Promise((done) => setTimeout(done, 50));
            if (i === 99) assert.fail(logs);
        }

        const adminAuth = await request(
            "/api/collections/_superusers/auth-with-password",
            { method: "POST", body: { identity: "test@example.com", password } },
        );
        assert.equal(adminAuth.status, 200, JSON.stringify(adminAuth.data));
        const admin = adminAuth.data.token;
        async function user(email) {
            const record = await request("/api/collections/users/records", {
                method: "POST",
                token: admin,
                body: { email, password, passwordConfirm: password },
            });
            assert.equal(record.status, 200, JSON.stringify(record.data));
            const auth = await request("/api/collections/users/auth-with-password", {
                method: "POST",
                body: { identity: email, password },
            });
            assert.equal(auth.status, 200, JSON.stringify(auth.data));
            return { id: record.data.id, token: auth.data.token };
        }

        const alice = await user("alice@example.com"),
            bob = await user("bob@example.com");
        const expense = {
            merchant: "Coffee",
            amount: 650,
            currency: "SGD",
            category: "Food & drinks",
            occurred_at: "2026-10-26T08:00:00+08:00",
            notes: "",
            payment_method: "Visa",
        };
        let first, writeKey, readKey;
        await t.test(
            "native expense rules protect ownership and source provenance",
            async () => {
                assert.equal(
                    (
                        await request("/api/collections/expenses/records", {
                            method: "POST",
                            body: { ...expense, user: alice.id, source: "manual" },
                        })
                    ).status,
                    400,
                );
                const created = await request("/api/collections/expenses/records", {
                    method: "POST",
                    token: alice.token,
                    body: {
                        ...expense,
                        user: alice.id,
                        source: "api",
                        idempotency_key: "spoof",
                        idempotency_data: { merchant: "Spoof" },
                    },
                });
                assert.equal(created.status, 200, JSON.stringify(created.data));
                first = created.data;
                assert.equal(first.source, "manual");
                assert.equal(first.idempotency_key, undefined);
                assert.equal(first.idempotency_data, undefined);
                assert.equal((await request(`/api/collections/expenses/records/${first.id}`, { token: admin })).data.idempotency_data, undefined);
                assert.equal(
                    (
                        await request("/api/collections/expenses/records", {
                            token: bob.token,
                        })
                    ).data.totalItems,
                    0,
                );
                assert.equal(
                    (
                        await request(`/api/collections/expenses/records/${first.id}`, {
                            token: bob.token,
                        })
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(`/api/collections/expenses/records/${first.id}`, {
                            token: bob.token,
                            method: "PATCH",
                            body: { merchant: "stolen" },
                        })
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(`/api/collections/expenses/records/${first.id}`, {
                            token: bob.token,
                            method: "DELETE",
                        })
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(`/api/collections/expenses/records/${first.id}`, {
                            token: alice.token,
                            method: "PATCH",
                            body: { user: bob.id },
                        })
                    ).status,
                    404,
                );
                const edit = await request(
                    `/api/collections/expenses/records/${first.id}`,
                    {
                        token: alice.token,
                        method: "PATCH",
                        body: { merchant: "Edited coffee", source: "api" },
                    },
                );
                assert.equal(edit.status, 200, JSON.stringify(edit.data));
                assert.equal(edit.data.source, "manual");
                assert.equal(
                    (
                        await request("/api/collections/expenses/records", {
                            method: "POST",
                            token: alice.token,
                            body: { ...expense, user: bob.id, source: "manual" },
                        })
                    ).status,
                    400,
                );
            },
        );
        await t.test(
            "keys are generated once and only hashes are stored",
            async () => {
                assert.equal(
                    (
                        await request("/api/expenditure/keys", {
                            method: "POST",
                            body: { name: "unauthenticated" },
                        })
                    ).status,
                    401,
                );
                assert.equal(
                    (
                        await request("/api/collections/api_keys/records", {
                            token: alice.token,
                        })
                    ).status,
                    403,
                );
                assert.equal(
                    (
                        await request("/api/collections/api_keys/records", {
                            token: alice.token,
                            method: "POST",
                            body: { user: alice.id },
                        })
                    ).status,
                    403,
                );
                assert.equal(
                    (
                        await request("/api/expenditure/keys", {
                            token: alice.token,
                            method: "POST",
                            body: { name: "Bad", scopes: ["admin"], expires_at: new Date(Date.now() + 90 * 86400000).toISOString() },
                        })
                    ).status,
                    400,
                );
                const result = await request("/api/expenditure/keys", {
                    token: alice.token,
                    method: "POST",
                    body: {
                        name: "iPhone",
                        scopes: ["expenses:write"],
                        expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
                    },
                });
                assert.equal(result.status, 201, JSON.stringify(result.data));
                writeKey = result.data;
                assert.match(writeKey.key, /^exp_[A-Za-z0-9]{48}$/);
                assert.equal(writeKey.record.key_hash, undefined);
                const listed = await request("/api/expenditure/keys", {
                    token: alice.token,
                });
                assert.equal(listed.data.items.length, 1);
                assert.equal(listed.data.items[0].key, undefined);
                assert.equal(listed.data.items[0].key_hash, undefined);
                assert.equal(
                    (await request("/api/expenditure/keys", { token: bob.token })).data
                        .items.length,
                    0,
                );
                const stored = await request(
                    `/api/collections/api_keys/records/${writeKey.record.id}`,
                    { token: admin, headers: { "X-Read-Test": "true" } },
                );
                assert.equal(stored.status, 200);
                // Hidden hashes are not exported even to admin clients; verify by filtering.
                const hash = createHash("sha256").update(writeKey.key).digest("hex");
                const match = await request(
                    `/api/collections/api_keys/records?filter=${encodeURIComponent(`key_hash = '${hash}'`)}`,
                    { token: admin },
                );
                assert.equal(match.data.totalItems, 1);
            },
        );
        await t.test(
            "API validates inputs, infers owner, and deduplicates retries",
            async () => {
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            method: "POST",
                            key: "invalid",
                            body: expense,
                        })
                    ).status,
                    401,
                );
                for (const body of [
                    { ...expense, amount: 6.5 },
                    { ...expense, amount: -1 },
                    { ...expense, amount: "650" },
                    { ...expense, amount_cents: 650 },
                    { ...expense, amount_minor: 650 },
                    { ...expense, card: "Visa" },
                    { ...expense, currency: "XYZ" },
                    { ...expense, currency: "" },
                    { ...expense, currency: "sgd" },
                    { ...expense, currency: "CHF" },
                    { ...expense, category: "invalid" },
                    { ...expense, category: " " },
                    { ...expense, category: "a".repeat(61) },
                    { ...expense, payment_method: "a".repeat(81) },
                    { ...expense, card: "a".repeat(81) },
                    { ...expense, notes: "a".repeat(2001) },
                    { ...expense, payment_method: "Cash", card: "Visa" },
                    ...["currency", "category", "payment_method", "card", "notes"].flatMap(
                        (field) => [null, false, 42, [], {}].map(
                            (value) => ({ ...expense, [field]: value }),
                        ),
                    ),
                    { ...expense, user: bob.id },
                    { ...expense, occurred_at: "2026-10-26" },
                    { ...expense, occurred_at: "2026-02-30T12:00:00+08:00" },
                ]) {
                    const result = await request("/api/expenses/transactions", {
                        method: "POST",
                        key: writeKey.key,
                        body,
                    });
                    assert.equal(result.status, 400, JSON.stringify({ body, response: result.data }));
                }

                const created = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: expense,
                    headers: { "Idempotency-Key": "wallet-transaction-1" },
                });
                assert.equal(created.status, 201, JSON.stringify(created.data));
                assert.equal(created.data.user, alice.id);
                assert.equal(created.data.source, "api");
                assert.equal(created.data.idempotency_key, undefined);
                const replay = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: expense,
                    headers: { "Idempotency-Key": "wallet-transaction-1" },
                });
                assert.equal(replay.status, 200, JSON.stringify(replay.data));
                assert.equal(replay.data.id, created.data.id);
                assert.equal(replay.data.replay, true);
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            method: "POST",
                            key: writeKey.key,
                            body: { ...expense, amount: 700 },
                            headers: { "Idempotency-Key": "wallet-transaction-1" },
                        })
                    ).status,
                    409,
                );
                const parallel = await Promise.all(
                    Array.from({ length: 5 }, () =>
                        request("/api/expenses/transactions", {
                            method: "POST",
                            key: writeKey.key,
                            body: expense,
                            headers: { "Idempotency-Key": "parallel-test" },
                        }),
                    ),
                );
                assert.equal(
                    parallel.filter((r) => r.status === 201).length,
                    1,
                    JSON.stringify(parallel),
                );
                assert.ok(parallel.every((r) => [200, 201].includes(r.status)));
            },
        );
        await t.test("read and write scopes are independent", async () => {
            assert.equal(
                (await request("/api/expenses/transactions", { key: writeKey.key }))
                    .status,
                403,
            );
            const result = await request("/api/expenditure/keys", {
                token: alice.token,
                method: "POST",
                body: {
                    name: "Read only",
                    scopes: ["expenses:read"],
                    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                },
            });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            readKey = result.data;
            assert.equal(
                (
                    await request("/api/expenses/transactions", {
                        method: "POST",
                        key: readKey.key,
                        body: expense,
                    })
                ).status,
                403,
            );
            const list = await request("/api/expenses/transactions?perPage=2", {
                key: readKey.key,
            });
            assert.equal(list.status, 200, JSON.stringify(list.data));
            assert.equal(list.data.items.length, 2);
            assert.ok(list.data.items.every((r) => r.user === alice.id));
            assert.ok(list.data.items.every((r) => typeof r.amount === "number" && !("amount_cents" in r) && !("amount_minor" in r) && !("card" in r)));
            assert.equal(list.data.totalItems, 3);
            assert.equal(
                (await request("/api/expenditure/keys", { key: readKey.key })).status,
                401,
            );
        });
        await t.test(
            "aggregation uses complete monthly data, currency and timezone bounds",
            async () => {
                await request("/api/collections/expenses/records", {
                    method: "POST",
                    token: alice.token,
                    body: {
                        ...expense,
                        user: alice.id,
                        source: "manual",
                        currency: "USD",
                        amount: 9900,
                    },
                });
                await request("/api/collections/expenses/records", {
                    method: "POST",
                    token: bob.token,
                    body: {
                        ...expense,
                        user: bob.id,
                        source: "manual",
                        amount: 8800,
                    },
                });
                await request("/api/collections/expenses/records", {
                    method: "POST",
                    token: alice.token,
                    body: {
                        ...expense,
                        user: alice.id,
                        source: "manual",
                        occurred_at: "2026-09-30T23:59:00+08:00",
                        amount: 1000,
                    },
                });
                await request("/api/collections/expenses/records", {
                    method: "POST",
                    token: alice.token,
                    body: {
                        ...expense,
                        user: alice.id,
                        source: "manual",
                        occurred_at: "2026-10-01T00:00:00+08:00",
                        amount: 500,
                    },
                });
                const query = new URLSearchParams({
                    from: "2026-09-30T16:00:00Z",
                    to: "2026-10-31T16:00:00Z",
                    previous: "2026-08-31T16:00:00Z",
                    currency: "SGD",
                });
                const summary = await request(`/api/expenditure/overview?${query}`, {
                    token: alice.token,
                });
                assert.equal(summary.status, 200, JSON.stringify(summary.data));
                assert.equal(summary.data.total, 2450);
                assert.equal(summary.data.count, 4);
                assert.equal(summary.data.previous, 1000);
                assert.equal(summary.data.categories[0].total, 2450);
                assert.equal(
                    summary.data.activity.reduce((sum, r) => sum + r.total, 0),
                    2450,
                );
                assert.equal(
                    (await request(`/api/expenditure/overview?${query}`)).status,
                    401,
                );
                // Match the SDK's native filter representation at the exact local midnight.
                const from = new Date(query.get("from"))
                    .toISOString()
                    .replace("T", " ");
                const to = new Date(query.get("to")).toISOString().replace("T", " ");
                const filter = `occurred_at >= '${from}' && occurred_at < '${to}' && currency = 'SGD'`;
                const native = await request(
                    `/api/collections/expenses/records?filter=${encodeURIComponent(filter)}&perPage=2`,
                    { token: alice.token },
                );
                assert.equal(native.status, 200, JSON.stringify(native.data));
                assert.equal(native.data.totalItems, 4);
                assert.equal(native.data.items.length, 2);
            },
        );
        await t.test(
            "budget and preference ownership and uniqueness are enforced",
            async () => {
                const body = {
                    user: alice.id,
                    month: "2026-10",
                    category: "Overall",
                    currency: "SGD",
                    amount: 100000,
                };
                const result = await request("/api/collections/budgets/records", {
                    token: alice.token,
                    method: "POST",
                    body,
                });
                assert.equal(result.status, 200, JSON.stringify(result.data));
                assert.equal(
                    (
                        await request("/api/collections/budgets/records", {
                            token: alice.token,
                            method: "POST",
                            body,
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (
                        await request("/api/collections/budgets/records", {
                            token: bob.token,
                        })
                    ).data.totalItems,
                    0,
                );
                const prefs = {
                    user: alice.id,
                    currency: "SGD",
                    timezone: "Asia/Singapore",
                    currencies: ["SGD", "USD", "EUR", "GBP", "AUD", "MYR"],
                };
                const configured = await request("/api/expenditure/config", { token: alice.token });
                const preference = await request(
                    `/api/collections/preferences/records/${configured.data.preferences.id}`,
                    { token: alice.token, method: "PATCH", body: prefs },
                );
                assert.equal(preference.status, 200, JSON.stringify(preference.data));
                const changed = await request(
                    `/api/collections/preferences/records/${preference.data.id}`,
                    {
                        token: alice.token,
                        method: "PATCH",
                        body: { timezone: "America/New_York" },
                    },
                );
                assert.equal(changed.status, 200, JSON.stringify(changed.data));
                assert.equal(changed.data.timezone, "America/New_York");
                assert.equal((await request(`/api/collections/preferences/records/${preference.data.id}`, {
                    token: alice.token, method: "PATCH", body: { currencies: [] },
                })).status, 400);
                assert.equal(
                    (
                        await request(
                            `/api/collections/preferences/records/${preference.data.id}`,
                            { token: bob.token, method: "PATCH", body: { timezone: "UTC" } },
                        )
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request("/api/collections/preferences/records", {
                            token: alice.token,
                            method: "POST",
                            body: prefs,
                        })
                    ).status,
                    400,
                );
                const bobPreferences = await request("/api/collections/preferences/records", { token: bob.token });
                assert.equal(bobPreferences.data.totalItems, 1);
                assert.equal(bobPreferences.data.items[0].user, bob.id);
                assert.equal(bobPreferences.data.items[0].timezone, "Asia/Singapore");
                assert.notEqual(bobPreferences.data.items[0].id, preference.data.id);
            },
        );
        await t.test(
            "custom categories and currencies stay private and renamed labels resolve through IDs",
            async () => {
                const result = await request("/api/expenditure/config", {
                    token: alice.token,
                });
                assert.equal(result.status, 200, JSON.stringify(result.data));
                assert.equal(result.data.categories.filter((row) => row.kind === "expense").length, 8);
                assert.equal((await request("/api/expenditure/config")).status, 401);
                const category = await request("/api/expenditure/categories", {
                    token: alice.token,
                    method: "POST",
                    body: { name: "Travel", color: "#aabbcc" },
                });
                assert.equal(category.status, 201, JSON.stringify(category.data));
                assert.equal(
                    (
                        await request("/api/expenditure/categories", {
                            token: alice.token,
                            method: "POST",
                            body: { name: "travel", color: "#aabbcc" },
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (
                        await request("/api/expenditure/categories", {
                            token: alice.token,
                            method: "POST",
                            body: { name: "Overall", color: "#aabbcc" },
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (
                        await request("/api/collections/categories/records", {
                            token: alice.token,
                            method: "POST",
                            body: { name: "Bypass", user: alice.id },
                        })
                    ).status,
                    403,
                );
                assert.equal(
                    (
                        await request(`/api/expenditure/categories/${category.data.id}`, {
                            token: bob.token,
                            method: "PATCH",
                            body: { name: "Stolen" },
                        })
                    ).status,
                    404,
                );
                assert.ok(
                    !(
                        await request("/api/expenditure/config", { token: bob.token })
                    ).data.categories.some((c) => c.name === "Travel"),
                );
                const preference = (
                    await request("/api/collections/preferences/records", {
                        token: alice.token,
                    })
                ).data.items[0];
                const updated = await request(
                    `/api/collections/preferences/records/${preference.id}`,
                    {
                        token: alice.token,
                        method: "PATCH",
                        body: {
                            currency: "SGD",
                            currencies: ["SGD", "USD", "EUR", "JPY", "KWD"],
                        },
                    },
                );
                assert.equal(updated.status, 200, JSON.stringify(updated.data));
                assert.equal(
                    (
                        await request(
                            `/api/collections/preferences/records/${preference.id}`,
                            {
                                token: alice.token,
                                method: "PATCH",
                                body: { currencies: ["USD"] },
                            },
                        )
                    ).status,
                    400,
                );
                const yen = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: {
                        ...expense,
                        currency: "JPY",
                        amount: 1000,
                        category: "Travel",
                    },
                });
                assert.equal(yen.status, 201, JSON.stringify(yen.data));
                assert.equal(yen.data.amount, 1000);
                const dinar = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: {
                        ...expense,
                        currency: "KWD",
                        amount: 1234,
                        category: "Travel",
                    },
                });
                assert.equal(dinar.status, 201, JSON.stringify(dinar.data));
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            method: "POST",
                            key: writeKey.key,
                            body: { ...expense, amount: 6.5, currency: "JPY", category: "Travel" },
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            method: "POST",
                            key: writeKey.key,
                            body: { ...expense, category: "Someone else's category" },
                        })
                    ).status,
                    400,
                );
                const budget = await request("/api/collections/budgets/records", {
                    token: alice.token,
                    method: "POST",
                    body: {
                        user: alice.id,
                        month: "2026-10",
                        currency: "SGD",
                        category: "Travel",
                        amount: 50000,
                    },
                });
                assert.equal(budget.status, 200, JSON.stringify(budget.data));
                const renamed = await request(
                    `/api/expenditure/categories/${category.data.id}`,
                    {
                        token: alice.token,
                        method: "PATCH",
                        body: { name: "Trips", color: "#123456" },
                    },
                );
                assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
                assert.equal(
                    (
                        await request(`/api/collections/expenses/records/${yen.data.id}`, {
                            token: alice.token,
                        })
                    ).data.expand.category.name,
                    "Trips",
                );
                assert.equal(
                    (
                        await request(
                            `/api/collections/budgets/records/${budget.data.id}`,
                            { token: alice.token },
                        )
                    ).data.expand.category.name,
                    "Trips",
                );
                assert.equal(
                    (
                        await request(`/api/expenditure/categories/${category.data.id}`, {
                            token: alice.token,
                            method: "PATCH",
                            body: { active: false },
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            method: "POST",
                            key: writeKey.key,
                            body: { ...expense, category: "Trips" },
                        })
                    ).status,
                    400,
                );
                const edited = await request(
                    `/api/collections/expenses/records/${yen.data.id}`,
                    {
                        token: alice.token,
                        method: "PATCH",
                        body: { notes: "Archived category is retained" },
                    },
                );
                assert.equal(edited.status, 200, JSON.stringify(edited.data));
                assert.equal(edited.data.expand.category.name, "Trips");
                assert.equal(edited.data.source, "api");
            },
        );
        await t.test("category ordering is private, atomic, persistent and rejects stale changes", async () => {
            const path = "/api/expenditure/categories/reorder";
            const original = (await request("/api/expenditure/config", { token: alice.token })).data.categories.filter((row) => row.kind === "expense");
            const other = (await request("/api/expenditure/config", { token: bob.token })).data.categories.filter((row) => row.kind === "expense");
            const ids = original.map((category) => category.id);
            const reversed = ids.slice().reverse();
            const body = { ids: reversed, previous_ids: ids };
            assert.equal((await request(path, { method: "POST", body })).status, 401);
            assert.equal((await request(path, { method: "POST", key: writeKey.key, body })).status, 401);
            for (const invalid of [
                { ...body, ids: [] },
                { ...body, ids: ids.slice(1) },
                { ...body, ids: [ids[0], ...ids.slice(0, -1)] },
                { ...body, ids: [other[0].id, ...ids.slice(1)] },
                { ...body, ids: [null, ...ids.slice(1)] },
                { ...body, ids: Array(101).fill(ids[0]) },
                { ...body, user: bob.id },
            ]) {
                assert.equal((await request(path, { token: alice.token, method: "POST", body: invalid })).status, 400);
            }

            assert.deepEqual((await request("/api/expenditure/config", { token: alice.token })).data.categories.filter((row) => row.kind === "expense"), original);
            const reordered = await request(path, { token: alice.token, method: "POST", body });
            assert.equal(reordered.status, 200, JSON.stringify(reordered.data));
            assert.deepEqual(reordered.data.items.map((category) => category.id), reversed);
            assert.deepEqual(reordered.data.items.map((category) => category.sort_order), reversed.map((_, index) => index));
            for (const category of reordered.data.items) {
                const before = original.find((item) => item.id === category.id);
                assert.deepEqual([category.name, category.color, category.active], [before.name, before.color, before.active]);
            }

            assert.deepEqual((await request("/api/expenditure/config", { token: alice.token })).data.categories.filter((row) => row.kind === "expense").map((category) => category.id), reversed);
            assert.deepEqual((await request("/api/expenditure/config", { token: bob.token })).data.categories.filter((row) => row.kind === "expense"), other);
            assert.equal((await request(path, { token: alice.token, method: "POST", body })).status, 409);
            assert.equal((await request(`/api/collections/categories/records/${ids[0]}`, {
                token: alice.token, method: "PATCH", body: { sort_order: 99 },
            })).status, 403);

            const appended = await request("/api/expenditure/categories", {
                token: alice.token, method: "POST", body: { name: "Ordered addition", color: "#aabbcc" },
            });
            assert.equal(appended.status, 201, JSON.stringify(appended.data));
            assert.equal(appended.data.sort_order, ids.length);
            const current = [...reversed, appended.data.id];
            assert.equal((await request(path, {
                token: alice.token, method: "POST", body: { ids: reversed, previous_ids: reversed },
            })).status, 409);
            await request(`/api/expenditure/categories/${appended.data.id}`, {
                token: alice.token, method: "PATCH", body: { name: "Renamed ordered addition", active: false },
            });
            assert.deepEqual((await request("/api/expenditure/config", { token: alice.token })).data.categories.filter((row) => row.kind === "expense").map((category) => category.id), current);

            const first = current.slice(), second = current.slice();
            [first[0], first[1]] = [first[1], first[0]];
            [second[1], second[2]] = [second[2], second[1]];
            const concurrent = await Promise.all([first, second].map((order) => request(path, {
                token: alice.token, method: "POST", body: { ids: order, previous_ids: current },
            })));
            assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
            const winner = concurrent.find((result) => result.status === 200).data.items;
            assert.deepEqual((await request("/api/expenditure/config", { token: alice.token })).data.categories.filter((row) => row.kind === "expense").map((category) => category.id), winner.map((category) => category.id));
        });
        await t.test(
            "cached online rates convert all currencies and preserve originals",
            async () => {
                assert.equal((await request("/api/expenditure/rates")).status, 401);
                assert.equal(
                    (
                        await request("/api/collections/exchange_rates/records", {
                            token: alice.token,
                        })
                    ).status,
                    403,
                );
                const snapshot = await request("/api/expenditure/rates", {
                    token: alice.token,
                });
                assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
                assert.equal(
                    snapshot.data.quotes.SGD,
                    1.5,
                    JSON.stringify(snapshot.data),
                );
                assert.equal(snapshot.data.quotes.JPY, 150);
                assert.equal(fxRequests, 1);
                assert.equal(
                    (await request("/api/expenditure/rates", { token: bob.token })).data
                        .quotes.SGD,
                    1.5,
                );
                assert.equal(fxRequests, 1, "all users share the rate cache");
                const query = new URLSearchParams({
                    from: "2026-09-30T16:00:00Z",
                    to: "2026-10-31T16:00:00Z",
                    previous: "2026-08-31T16:00:00Z",
                    currency: "all",
                });
                const result = await request(`/api/expenditure/overview?${query}`, {
                    token: alice.token,
                });
                assert.equal(result.status, 200, JSON.stringify(result.data));
                assert.equal(result.data.currency, "SGD");
                assert.equal(result.data.total, 16442);
                assert.equal(result.data.count, 7);
                assert.equal(result.data.missing_count, 0);
                assert.equal(
                    result.data.activity.reduce((sum, row) => sum + row.total, 0),
                    16442,
                );
                assert.equal(
                    result.data.categories.find((c) => c.category_name === "Trips").total,
                    1617,
                );
                assert.equal(
                    result.data.original_totals.find((c) => c.currency === "JPY").total,
                    1000,
                );
                const preference = (
                    await request("/api/collections/preferences/records", {
                        token: alice.token,
                    })
                ).data.items[0];
                await request(`/api/collections/preferences/records/${preference.id}`, {
                    token: alice.token,
                    method: "PATCH",
                    body: { currency: "USD" },
                });
                const usd = await request(`/api/expenditure/overview?${query}`, {
                    token: alice.token,
                });
                assert.equal(usd.data.currency, "USD");
                assert.equal(usd.data.total, 13154);
                await request(`/api/collections/preferences/records/${preference.id}`, {
                    token: alice.token,
                    method: "PATCH",
                    body: { currency: "SGD" },
                });
                const originals = (
                    await request("/api/collections/expenses/records", {
                        token: alice.token,
                    })
                ).data.items;
                assert.equal(
                    originals.find((row) => row.currency === "JPY").amount,
                    1000,
                );
                fxStatus = 500;
                await request(
                    "/api/collections/exchange_rates/records/fxlatest0000000",
                    {
                        token: admin,
                        method: "PATCH",
                        body: {
                            fetched_at: "2020-01-01T00:00:00Z",
                            attempted_at: "2020-01-01T00:00:00Z",
                        },
                    },
                );
                const stale = await request("/api/expenditure/rates", {
                    token: alice.token,
                });
                assert.equal(stale.status, 200);
                assert.equal(stale.data.quotes.SGD, 1.5);
                assert.equal(stale.data.stale, true);
                assert.equal(fxRequests, 2);
                await request("/api/expenditure/rates", { token: alice.token });
                assert.equal(fxRequests, 2, "failed requests are throttled");
                await request(
                    "/api/collections/exchange_rates/records/fxlatest0000000",
                    {
                        token: admin,
                        method: "PATCH",
                        body: {
                            quotes: { EUR: 1, SGD: 1.5 }, dates: { SGD: rateDate },
                        },
                    },
                );
                const missing = await request(`/api/expenditure/overview?${query}`, {
                    token: alice.token,
                });
                assert.equal(missing.data.total, 2450);
                assert.equal(missing.data.missing_count, 3);
                assert.deepEqual(missing.data.missing_currencies, [
                    "JPY",
                    "KWD",
                    "USD",
                ]);
            },
        );
        await t.test("custom category names cannot collide with object properties", async () => {
            const category = await request("/api/expenditure/categories", {
                token: alice.token,
                method: "POST",
                body: { name: "__proto__", color: "#bfc9a4" },
            });
            assert.equal(category.status, 201, JSON.stringify(category.data));
            const added = await request("/api/collections/expenses/records", {
                token: alice.token,
                method: "POST",
                body: { ...expense, user: alice.id, source: "manual", category: "__proto__", amount: 100 },
            });
            assert.equal(added.status, 200, JSON.stringify(added.data));
            const query = new URLSearchParams({ from: "2026-09-30T16:00:00Z", to: "2026-10-31T16:00:00Z", previous: "2026-08-31T16:00:00Z", currency: "all" });
            const summary = await request(`/api/expenditure/overview?${query}`, { token: alice.token });
            assert.equal(summary.status, 200, JSON.stringify(summary.data));
            assert.equal(summary.data.categories.find((c) => c.category_name === "__proto__").total, 100);
        });
        await t.test(
            "API accepts category names and returns stored relation IDs",
            async () => {
                const body = {
                    merchant: "API coffee",
                    amount: 650,
                    currency: "USD",
                    category: "  food & DRINKS  ",
                    payment_method: "Visa",
                    notes: "First line\n  Second line",
                    occurred_at: expense.occurred_at,
                };
                const headers = { "Idempotency-Key": "metadata-test" };
                const created = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body,
                    headers,
                });
                assert.equal(created.status, 201, JSON.stringify(created.data));
                assert.equal(created.data.expand.category.name, "Food & drinks");
                assert.equal(created.data.currency, "USD");
                assert.equal(created.data.payment_method, "Visa");
                assert.equal(created.data.card, undefined);
                assert.equal(created.data.amount_cents, undefined);
                assert.equal(created.data.amount_minor, undefined);
                const native = await request(`/api/collections/expenses/records/${created.data.id}`, { token: alice.token });
                assert.equal(native.data.amount, created.data.amount);
                assert.equal(native.data.payment_method, created.data.payment_method);
                assert.equal(created.data.notes, body.notes);

                // The same canonical fields identify an exact retry.
                const replay = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body,
                    headers,
                });
                assert.equal(replay.status, 200, JSON.stringify(replay.data));
                assert.equal(replay.data.id, created.data.id);
                assert.equal(replay.data.replay, true);

                for (const change of [
                    { category: "Groceries" },
                    { currency: "EUR" },
                    { payment_method: "Cash" },
                    { notes: "Changed note" },
                ]) {
                    const conflict = await request("/api/expenses/transactions", {
                        method: "POST",
                        key: writeKey.key,
                        body: { ...body, ...change },
                        headers,
                    });
                    assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
                }

                const boundary = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: {
                        ...body,
                        payment_method: "x".repeat(80),
                        notes: "x".repeat(2000),
                    },
                });
                assert.equal(boundary.status, 201, JSON.stringify(boundary.data));
                assert.equal(boundary.data.payment_method.length, 80);
                assert.equal(boundary.data.notes.length, 2000);

                const defaults = await request("/api/expenses/transactions", {
                    method: "POST",
                    key: writeKey.key,
                    body: { merchant: "Defaults", amount: 100 },
                });
                assert.equal(defaults.status, 201, JSON.stringify(defaults.data));
                assert.equal(defaults.data.currency, "SGD");
                assert.equal(defaults.data.expand.category.name, "Other");
                assert.equal(defaults.data.payment_method, "");
                assert.equal(defaults.data.notes, "");

                const listed = await request("/api/expenses/transactions?perPage=100", {
                    key: readKey.key,
                });
                const saved = listed.data.items.find((item) => item.id === created.data.id);
                assert.equal(saved.payment_method, body.payment_method);
                assert.equal(saved.card, undefined);
                assert.equal(saved.notes, body.notes);
            },
        );
        await t.test("API retries compare an immutable request after edits, category changes and preference changes", async () => {
            const account = await user("retry@example.com");
            const config = (await request("/api/expenditure/config", { token: account.token })).data;
            const credentials = await request("/api/expenditure/keys", {
                token: account.token, method: "POST", body: { name: "Retry audit", scopes: ["expenses:write"], expires_at: "" },
            });
            assert.equal(credentials.status, 201, JSON.stringify(credentials.data));
            const category = await request("/api/expenditure/categories", {
                token: account.token, method: "POST", body: { name: "Retry category", color: "#123456" },
            });
            const input = { ...expense, merchant: "Immutable purchase", category: "  retry CATEGORY  ", occurred_at: "2090-01-01T04:00:45.123Z" };
            const send = (body, marker = "immutable-retry") => request("/api/expenses/transactions", {
                key: credentials.data.key, method: "POST", headers: { "Idempotency-Key": marker }, body,
            });
            const original = await send(input);
            assert.equal(original.status, 201, JSON.stringify(original.data));
            assert.equal(original.data.idempotency_data, undefined);
            const storedPath = `/api/collections/expenses/records/${original.data.id}`;
            const receiptQuery = `/api/collections/api_transaction_retries/records?filter=${encodeURIComponent(`user = '${account.id}' && key = 'immutable-retry'`)}`;
            const receipt = (await request(receiptQuery, { token: admin })).data.items[0];
            const snapshot = receipt.request;
            const changes = { amount: 700, notes: "Corrected note", occurred_at: "2090-02-01T04:00:00Z" };
            const edited = await request(storedPath, {
                token: account.token, method: "PATCH", body: { ...changes, idempotency_data: { ...snapshot, ...changes }, idempotency_key: "overwrite" },
            });
            assert.equal(edited.status, 200, JSON.stringify(edited.data));
            assert.equal(edited.data.idempotency_data, undefined);
            assert.deepEqual((await request(`/api/collections/api_transaction_retries/records/${receipt.id}`, { token: admin })).data.request, snapshot);
            const replay = await send(input);
            assert.equal(replay.status, 200, JSON.stringify(replay.data));
            assert.equal(replay.data.id, original.data.id);
            assert.equal(replay.data.amount, changes.amount);
            assert.equal(replay.data.notes, changes.notes);
            assert.equal(replay.data.replay, true);
            assert.equal(replay.data.idempotency_expires_at, original.data.idempotency_expires_at);
            assert.equal((await send({ ...input, ...changes })).status, 409);
            assert.equal((await send({ ...input, idempotency_data: snapshot })).status, 400);
            await request(`/api/expenditure/categories/${category.data.id}`, {
                token: account.token, method: "PATCH", body: { active: false },
            });
            assert.equal((await send(input)).status, 200);
            const renamed = await request(`/api/expenditure/categories/${category.data.id}`, {
                token: account.token, method: "PATCH", body: { name: "Renamed category" },
            });
            assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
            assert.equal((await send(input)).status, 200);
            assert.equal((await send({ ...input, category: "Renamed category" })).status, 409);

            const defaults = { merchant: "Original defaults", amount: 123 };
            const defaultExpense = await send(defaults, "default-retry");
            assert.equal(defaultExpense.status, 201, JSON.stringify(defaultExpense.data));
            const other = config.categories.find((row) => row.name === "Other");
            await request(`/api/expenditure/categories/${other.id}`, { token: account.token, method: "PATCH", body: { name: "Old default", active: false } });
            const preferences = await request(`/api/collections/preferences/records/${config.preferences.id}`, {
                token: account.token, method: "PATCH", body: { currency: "USD", currencies: ["USD"] },
            });
            assert.equal(preferences.status, 200, JSON.stringify(preferences.data));
            assert.equal((await send(input)).status, 200);
            const defaultReplay = await send(defaults, "default-retry");
            assert.equal(defaultReplay.status, 200, JSON.stringify(defaultReplay.data));
            assert.equal(defaultReplay.data.id, defaultExpense.data.id);
            assert.equal(defaultReplay.data.currency, "SGD");
            const fresh = await send(defaults, "new-defaults");
            assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
            assert.equal(fresh.data.currency, "USD");
            assert.notEqual(fresh.data.expand.category.name, "Old default");
            assert.equal((await request("/api/collections/expenses/records", { token: account.token })).data.totalItems, 3);
        });
        await t.test("idempotency expires after 24 hours without deleting expenses or extending on retries", async () => {
            const day = 24 * 60 * 60 * 1000;
            // PocketBase's native API ignores autodate edits, even for superusers.
            // Age only this test's disposable records directly; never change the
            // production retention window or the machine's clock for testing.
            function ageRecords(ids, created) {
                const database = new DatabaseSync(join(directory, "data.db"));
                try {
                    database.exec("PRAGMA busy_timeout = 5000");
                    const update = database.prepare("UPDATE expenses SET created = ? WHERE id = ?");
                    const receipts = database.prepare("UPDATE api_transaction_retries SET created = ? WHERE \"transaction\" = ?");
                    for (const id of ids) {
                        update.run(created.replace("T", " "), id);
                        receipts.run(created.replace("T", " "), id);
                    }
                } finally {
                    database.close();
                }
            }

            const path = "/api/expenses/transactions";
            const headers = { "Idempotency-Key": "123456" };
            const category = await request("/api/expenditure/categories", {
                token: alice.token, method: "POST", body: { name: "Retry retention", color: "#aabbcc" },
            });
            assert.equal(category.status, 201, JSON.stringify(category.data));
            const body = { merchant: "First random-number purchase", amount: 650, currency: "SGD", category: category.data.name };
            const original = await request(path, { key: writeKey.key, method: "POST", headers, body });
            assert.equal(original.status, 201, JSON.stringify(original.data));
            assert.equal(Date.parse(original.data.idempotency_expires_at) - Date.parse(original.data.created.replace(" ", "T")), day);
            const replay = await request(path, { key: writeKey.key, method: "POST", headers, body });
            assert.equal(replay.status, 200);
            assert.equal(replay.data.id, original.data.id);
            assert.equal(replay.data.idempotency_expires_at, original.data.idempotency_expires_at);
            assert.equal((await request(path, {
                key: writeKey.key, method: "POST", headers, body: { ...body, amount: 700 },
            })).status, 409);

            const edited = await request(`/api/collections/expenses/records/${original.data.id}`, {
                token: alice.token, method: "PATCH", body: { created: new Date(Date.now() + day).toISOString() },
            });
            assert.equal(edited.status, 200, JSON.stringify(edited.data));
            assert.equal(edited.data.created, original.data.created);

            const bobKey = await request("/api/expenditure/keys", {
                token: bob.token, method: "POST", body: { name: "Independent retry namespace", scopes: ["expenses:write"], expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
            });
            const bobExpense = await request(path, { key: bobKey.data.key, method: "POST", headers, body: expense });
            assert.equal(bobExpense.status, 201, JSON.stringify(bobExpense.data));
            const expired = new Date(Date.now() - day - 1000).toISOString();
            ageRecords([original.data.id, bobExpense.data.id], expired);
            for (const id of [original.data.id, bobExpense.data.id]) {
                const result = await request(`/api/collections/expenses/records/${id}`, {
                    token: admin,
                });
                assert.equal(result.status, 200, JSON.stringify(result.data));
                assert.equal(Date.parse(result.data.created.replace(" ", "T")), Date.parse(expired));
            }

            const archived = await request(`/api/expenditure/categories/${category.data.id}`, {
                token: alice.token, method: "PATCH", body: { active: false },
            });
            assert.equal(archived.status, 200, JSON.stringify(archived.data));
            const before = await request(`/api/collections/expenses/records/${original.data.id}`, { token: admin });
            const nextBody = { ...expense, merchant: "New purchase after expiry" };
            const concurrent = await Promise.all(Array.from({ length: 5 }, () => request(path, {
                key: writeKey.key, method: "POST", headers, body: nextBody,
            })));
            assert.equal(concurrent.filter((result) => result.status === 201).length, 1, JSON.stringify(concurrent));
            assert.ok(concurrent.every((result) => [200, 201].includes(result.status)), JSON.stringify(concurrent));
            const saved = concurrent.find((result) => result.status === 201).data;
            assert.notEqual(saved.id, original.data.id);
            assert.ok(Date.parse(saved.idempotency_expires_at) > Date.now());
            assert.ok(concurrent.every((result) => result.data.id === saved.id && result.data.idempotency_expires_at === saved.idempotency_expires_at));
            assert.deepEqual((await request(`/api/collections/expenses/records/${original.data.id}`, { token: admin })).data, before.data);
            const oldReceipt = await request(`/api/collections/api_transaction_retries/records?filter=${encodeURIComponent(`transaction = '${original.data.id}'`)}`, { token: admin });
            assert.equal(oldReceipt.data.totalItems, 0);
            const otherReceipt = await request(`/api/collections/api_transaction_retries/records?filter=${encodeURIComponent(`transaction = '${bobExpense.data.id}' && key = '123456'`)}`, { token: admin });
            assert.equal(otherReceipt.data.totalItems, 0);
            assert.equal((await request(`/api/collections/expenses/records/${bobExpense.data.id}`, { token: admin })).status, 200);

            // Once expired, even identical data is a new request; late retries
            // must not rely on deduplication beyond the documented window.
            ageRecords([saved.id], expired);
            const lateRetry = await request(path, { key: writeKey.key, method: "POST", headers, body: nextBody });
            assert.equal(lateRetry.status, 201, JSON.stringify(lateRetry.data));
            assert.notEqual(lateRetry.data.id, saved.id);
            const noKey = await request(path, { key: writeKey.key, method: "POST", body: nextBody });
            assert.equal(noKey.status, 201, JSON.stringify(noKey.data));
            assert.equal(noKey.data.idempotency_expires_at, null);
        });
        await t.test("non-expiring keys retain scopes and can be revoked", async () => {
            const alias = await request("/api/expenditure/keys", {
                token: alice.token, method: "POST",
                body: { name: "Old alias", scopes: ["expenses:read"], expires_at: "", expires_in_days: 90 },
            });
            assert.equal(alias.status, 400, JSON.stringify(alias.data));
            const expires_at = new Date(Date.now() + 45 * 86400000).toISOString();
            const dated = await request("/api/expenditure/keys", {
                token: alice.token, method: "POST", body: { name: "Direct expiry", scopes: ["expenses:read"], expires_at },
            });
            assert.equal(dated.status, 201, JSON.stringify(dated.data));
            assert.equal(Date.parse(dated.data.record.expires_at), Date.parse(expires_at));
            await request(`/api/expenditure/keys/${dated.data.record.id}`, { token: alice.token, method: "DELETE" });
            for (const expires_at of [undefined, null, 0, -1, "90", "never", false, {}, [], "2020-01-01T00:00:00Z", "2099-02-30T00:00:00Z", "2099-01-01T00:00:00"]) {
                const invalid = await request("/api/expenditure/keys", {
                    token: alice.token,
                    method: "POST",
                    body: { name: "Invalid expiry", scopes: ["expenses:read"], expires_at },
                });
                assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
            }

            const result = await request("/api/expenditure/keys", {
                token: alice.token,
                method: "POST",
                body: { name: "No expiry", scopes: ["expenses:read"], expires_at: "" },
            });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            assert.equal(result.data.record.expires_at, "");
            const permanent = result.data;
            const listed = await request("/api/expenditure/keys", { token: alice.token });
            assert.equal(listed.data.items.find((key) => key.id === permanent.record.id).expires_at, "");
            assert.equal((await request("/api/expenses/transactions", { key: permanent.key })).status, 200);
            assert.equal((await request("/api/expenses/transactions", {
                key: permanent.key,
                method: "POST",
                body: expense,
            })).status, 403);
            assert.equal((await request(`/api/expenditure/keys/${permanent.record.id}`, {
                token: bob.token,
                method: "DELETE",
            })).status, 404);
            assert.equal((await request(`/api/expenditure/keys/${permanent.record.id}`, {
                token: alice.token,
                method: "DELETE",
            })).status, 200);
            assert.equal((await request("/api/expenses/transactions", { key: permanent.key })).status, 401);
        });
        await t.test(
            "revocation, expiration and deleted users lose access immediately",
            async () => {
                assert.equal(
                    (
                        await request(`/api/expenditure/keys/${writeKey.record.id}`, {
                            token: bob.token,
                            method: "DELETE",
                        })
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(`/api/expenditure/keys/${writeKey.record.id}`, {
                            token: alice.token,
                            method: "DELETE",
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request("/api/expenses/transactions", {
                            key: writeKey.key,
                            method: "POST",
                            body: expense,
                        })
                    ).status,
                    401,
                );
                await request(
                    `/api/collections/api_keys/records/${readKey.record.id}`,
                    {
                        token: admin,
                        method: "PATCH",
                        body: { expires_at: "2020-01-01T00:00:00Z" },
                    },
                );
                assert.equal(
                    (await request("/api/expenses/transactions", { key: readKey.key }))
                        .status,
                    401,
                );
                const fresh = await request("/api/expenditure/keys", {
                    token: bob.token,
                    method: "POST",
                    body: {
                        name: "Delete user test",
                        scopes: ["expenses:read"],
                        expires_at: "",
                    },
                });
                assert.equal((await request(`/api/collections/users/records/${bob.id}`, {
                    token: admin,
                    method: "DELETE",
                })).status, 204);
                assert.equal(
                    (await request("/api/expenses/transactions", { key: fresh.data.key }))
                        .status,
                    401,
                );
            },
        );
        await t.test(
            "active key limit includes non-expiring keys and recovers after revocation",
            async () => {
                const records = [];
                for (let index = 0; index < 20; index++) {
                    const result = await request("/api/expenditure/keys", {
                        token: alice.token,
                        method: "POST",
                        body: {
                            name: `Limit test ${index}`,
                            scopes: ["expenses:write"],
                            expires_at: index % 2 === 0 ? "" : new Date(Date.now() + 30 * 86400000).toISOString(),
                        },
                    });
                    assert.equal(result.status, 201, JSON.stringify(result.data));
                    records.push(result.data.record);
                }

                const body = {
                    name: "Over limit",
                    scopes: ["expenses:write"],
                    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                };
                assert.equal(
                    (
                        await request("/api/expenditure/keys", {
                            token: alice.token,
                            method: "POST",
                            body,
                        })
                    ).status,
                    400,
                );
                await request(`/api/expenditure/keys/${records[0].id}`, {
                    token: alice.token,
                    method: "DELETE",
                });
                assert.equal(
                    (
                        await request("/api/expenditure/keys", {
                            token: alice.token,
                            method: "POST",
                            body,
                        })
                    ).status,
                    201,
                );
            },
        );
    },
);
