import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";

test(
    "PocketBase migrations, user isolation, and aggregation",
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
            { token, method = "GET", body, headers = {} } = {},
        ) {
            ({ path, body } = await resolveCategoryFixture(base, path, body, token));
            const response = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { Authorization: token } : {}),
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
        let first;
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
                for (let index = 0; index < 2; index++) {
                    const saved = await request("/api/collections/expenses/records", {
                        method: "POST", token: alice.token, body: { ...expense, user: alice.id },
                    });
                    assert.equal(saved.status, 200);
                }
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
                const writeShortcut = (body) => request("/api/collections/expenses/records", {
                    token: alice.token, method: "POST", headers: { "X-Expenditure-Source": "shortcut" },
                    body: { ...expense, user: alice.id, ...body },
                });
                const yen = await writeShortcut({ currency: "JPY", amount: 1000, category: category.data.id });
                assert.equal(yen.status, 200, JSON.stringify(yen.data));
                assert.equal(yen.data.amount, 1000);
                const dinar = await writeShortcut({ currency: "KWD", amount: 1234, category: category.data.id });
                assert.equal(dinar.status, 200, JSON.stringify(dinar.data));
                assert.equal(dinar.data.amount, 1234);
                assert.equal((await writeShortcut({ amount: 6.5, currency: "JPY", category: category.data.id })).status, 400);
                assert.equal((await writeShortcut({ category: "Someone else's category" })).status, 400);
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
                assert.equal((await writeShortcut({ category: category.data.id })).status, 400);
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
                assert.equal(edited.data.source, "shortcut");
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
            assert.equal((await request(path, { method: "POST", token: "retired-key", body })).status, 401);
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
    },
);
