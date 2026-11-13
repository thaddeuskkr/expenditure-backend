import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test(
    "Circle categories, owner replacement and personal expense moves",
    { timeout: 60000 },
    async (t) => {
        const binary = process.env.POCKETBASE_BINARY;
        assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
        const directory = await mkdtemp(join(tmpdir(), "expenditure-circles-"));
        const listener = createServer();
        await new Promise((done) => listener.listen(0, "127.0.0.1", done));
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const hooks = join(directory, "hooks");
        await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
        await writeFile(join(hooks, "test.pb.js"), `routerAdd("POST", "/api/test/recurrence", (e) => {
            require(__hooks + "/recurrence.js").run(e.app, e.requestInfo().body.now);
            return e.json(200, {});
        }, $apis.requireAuth("_superusers"));
        routerAdd("POST", "/api/test/age", (e) => {
            const data = e.requestInfo().body;
            e.app.db().newQuery("UPDATE expenses SET created = {:created} WHERE id = {:id}").bind(data).execute();
            e.app.db().newQuery('UPDATE api_transaction_retries SET created = {:created} WHERE "transaction" = {:id}').bind(data).execute();
            return e.json(200, {});
        }, $apis.requireAuth("_superusers"));`);
        const flags = [
            `--dir=${directory}`,
            `--hooksDir=${hooks}`,
            `--migrationsDir=${resolve("pocketbase/pb_migrations")}`,
        ];
        const password = randomBytes(24).toString("hex");
        const setup = spawnSync(
            binary,
            ["superuser", "upsert", "admin@example.com", password, ...flags],
            { encoding: "utf8" },
        );
        assert.equal(setup.status, 0, setup.stdout + setup.stderr);
        const server = spawn(
            binary,
            [
                "serve",
                "--automigrate=false",
                "--hooksWatch=false",
                `--http=127.0.0.1:${port}`,
                ...flags,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        let logs = "";
        server.stdout.on("data", (c) => {
            logs += c;
        });
        server.stderr.on("data", (c) => {
            logs += c;
        });
        t.after(async () => {
            if (server.exitCode === null && server.signalCode === null) {
                const exited = new Promise((done) => server.once("exit", done));
                server.kill("SIGTERM");
                await exited;
            }

            await rm(directory, { recursive: true, force: true });
        });
        const base = `http://127.0.0.1:${port}`;
        async function api(
            path,
            token,
            body,
            method = body === undefined ? "GET" : "POST",
            expected = 200,
        ) {
            ({ path, body } = await resolveCategoryFixture(base, path, body, token));
            const response = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { Authorization: token } : {}),
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const content = await response.text();
            const data = content ? JSON.parse(content) : null;
            assert.equal(
                response.status,
                expected,
                JSON.stringify({ path, data }) + (response.status >= 500 ? logs : ""),
            );
            return data;
        }

        for (let i = 0; i < 100; i++) {
            try {
                if ((await fetch(base + "/api/health")).ok) break;
            } catch {}

            if (i === 99) assert.fail(logs);
            await new Promise((done) => setTimeout(done, 25));
        }

        const admin = (
            await api("/api/collections/_superusers/auth-with-password", null, {
                identity: "admin@example.com",
                password,
            })
        ).token;
        async function user(name, verified = true) {
            const record = await api("/api/collections/users/records", admin, {
                email: `${name}@example.com`,
                name,
                verified,
                password,
                passwordConfirm: password,
            });
            const auth = await api("/api/collections/users/auth-with-password", null, {
                identity: `${name}@example.com`,
                password,
            });
            return { ...record, token: auth.token };
        }

        const alice = await user("Alice"), bob = await user("Bob"), outsider = await user("Outside");
        const root = "/api/expenditure/circles";
        const circle = await api(root, alice.token, { name: "Shared ledger", icon: "users", currency: "SGD" }, "POST", 201);
        const otherCircle = await api(root, alice.token, { name: "Separate ledger", icon: "home", currency: "SGD" }, "POST", 201);
        const invite = await api(`${root}/${circle.id}/invitations`, alice.token, { email: bob.email }, "POST", 201);
        const bobMember = (await api(`/api/expenditure/circle-invitations/${invite.id}/accept`, bob.token, {})).member;
        const detail = () => api(`${root}/${circle.id}`, alice.token);
        const categoryPath = `${root}/${circle.id}/categories`;
        const personal = "/api/collections/expenses/records";
        const personalData = { user: bob.id, merchant: "Member's lunch", kind: "expense", recurrence: "", amount: 1234, currency: "SGD", category: "Other", notes: "Keep the note", payment_method: "Visa", occurred_at: "2026-10-27T04:00:00Z" };
        let historical, shared;
        await t.test("categories are Circle-local, owner-managed and validated", async () => {
            const initial = await detail();
            assert.equal(initial.categories.filter((row) => row.kind === "expense").length, 8);
            for (const kind of ["expense", "income"])
                assert.ok(initial.categories.filter((row) => row.kind === kind).every((row, index) => row.sort_order === index));
            await api("/api/collections/circle_categories/records", bob.token, undefined, "GET", 403);
            await api(categoryPath, bob.token, { name: "Not owner", color: "#123456" }, "POST", 403);
            await api(categoryPath, outsider.token, { name: "Outside", color: "#123456" }, "POST", 404);
            historical = await api(categoryPath, alice.token, { name: "Trip only", color: "#123456" }, "POST", 201);
            await api(categoryPath, alice.token, { name: "TRIP ONLY", color: "#123456" }, "POST", 400);
            for (const body of [{ name: "All", color: "#123456" }, { name: "Valid", color: "invalid" }, { name: "Valid", color: "#123456", user: bob.id }]) await api(categoryPath, alice.token, body, "POST", 400);
            assert.equal((await api(`${root}/${otherCircle.id}`, alice.token)).categories.filter((row) => row.kind === "expense").length, 8);
            shared = await api(`${root}/${circle.id}/expenses`, bob.token, { title: "Shared lunch", kind: "expense", amount: 99, currency: "SGD", category: historical.name, paid_by: bobMember, split_mode: "even", shares: [{ member: bobMember }], occurred_at: personalData.occurred_at }, "POST", 201);
            const renamed = await api(`${categoryPath}/${historical.id}`, alice.token, { name: "Trip history", color: "#abcdef" }, "PATCH");
            historical = renamed;
            let current = await detail();
            const entry = current.expenses.items.find((row) => row.id === shared.id);
            assert.equal(entry.expand.category.name, renamed.name);
            assert.equal(entry.amount, shared.amount);
            assert.equal(entry.version, shared.version);
            await api(`${categoryPath}/${historical.id}`, alice.token, { active: false }, "PATCH");
            await api(`${root}/${circle.id}/expenses`, bob.token, { title: "Archived", amount: 10, currency: "SGD", category: historical.name, paid_by: bobMember, split_mode: "even", shares: [{ member: bobMember }] }, "POST", 400);
            // A historical entry can still be edited without reactivating its category.
            shared = await api(`${root}/${circle.id}/expenses/${entry.id}`, bob.token, { ...entry, notes: "Changed" }, "PATCH", 400);
            shared = entry;
            shared = await api(`${root}/${circle.id}/expenses/${entry.id}`, bob.token, { title: entry.title, kind: entry.kind, amount: entry.amount, currency: entry.currency, category: entry.category, paid_by: entry.paid_by, split_mode: "even", shares: [{ member: bobMember }], occurred_at: personalData.occurred_at, version: entry.version }, "PATCH");
            current = await detail();
            const previous_ids = current.categories.filter((row) => row.kind === "expense").map((row) => row.id), ids = previous_ids.slice().reverse();
            await api(`${categoryPath}/reorder`, alice.token, { ids, previous_ids });
            assert.deepEqual((await detail()).categories.filter((row) => row.kind === "expense").map((row) => row.id), ids);
            await api(`${categoryPath}/reorder`, alice.token, { ids: previous_ids, previous_ids }, "POST", 409);
            await api(`${categoryPath}/reorder`, bob.token, { ids: previous_ids, previous_ids: ids }, "POST", 403);
        });
        await t.test("copying replaces the owner list and archives categories used in history", async () => {
            let config = await api("/api/expenditure/config", alice.token);
            const other = config.categories.find((row) => row.name === "Other");
            await api(`/api/expenditure/categories/${other.id}`, alice.token, { name: "Owner default", color: "#aa1122" }, "PATCH");
            const ownerExtra = await api("/api/expenditure/categories", alice.token, { name: "Owner extra", color: "#1122aa" }, "POST", 201);
            await api(`/api/expenditure/categories/${ownerExtra.id}`, alice.token, { active: false }, "PATCH");
            config = await api("/api/expenditure/config", alice.token);
            const before = await detail();
            const previous_ids = before.categories.filter((row) => row.kind === "expense").map((row) => row.id);
            await api(`${categoryPath}/copy`, bob.token, { previous_ids }, "POST", 403);
            await api(`${categoryPath}/copy`, alice.token, { previous_ids, user: bob.id }, "POST", 400);
            await api(`${categoryPath}/copy`, alice.token, { previous_ids: previous_ids.slice().reverse() }, "POST", 409);
            const copied = (await api(`${categoryPath}/copy`, alice.token, { previous_ids })).items;
            assert.deepEqual(copied.slice(0, config.categories.filter((row) => row.kind === "expense").length).map(({ name, color, active }) => ({ name, color, active })), config.categories.filter((row) => row.kind === "expense").map(({ name, color, active }) => ({ name, color, active })));
            assert.equal(copied.at(-1).id, historical.id);
            assert.equal(copied.at(-1).active, false);
            assert.ok(!copied.some((row) => row.name === "Other"));
            const after = await detail();
            assert.equal(after.expenses.items.find((row) => row.id === shared.id).expand.category.name, historical.name);
            assert.deepEqual(after.balances, before.balances);
            // Repeating a replacement is safe and does not grow archived history.
            const repeated = (await api(`${categoryPath}/copy`, alice.token, { previous_ids: copied.map((row) => row.id) })).items;
            assert.deepEqual(repeated.map((row) => row.id), copied.map((row) => row.id));
            const active = repeated.filter((row) => row.active);
            for (const category of active.slice(1)) await api(`${categoryPath}/${category.id}`, alice.token, { active: false }, "PATCH");
            await api(`${categoryPath}/${active[0].id}`, alice.token, { active: false }, "PATCH", 400);
        });
        let moved;
        const activeCategory = () => detail().then((result) => result.categories.find((row) => row.kind === "expense" && row.active).name);
        await t.test("members can move only their own expenses and receive the entire initial share", async () => {
            const query = new URLSearchParams({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", previous: "2026-09-01T00:00:00Z", currency: "all" });
            const baseline = await api(`/api/expenditure/overview?${query}`, bob.token);
            const own = await api(personal, bob.token, personalData);
            assert.equal((await api(`/api/expenditure/overview?${query}`, bob.token)).total, baseline.total + own.amount);
            const category = await activeCategory();
            const request = { expense: own.id, previous_updated: own.updated, category };
            await api(`${root}/${circle.id}/expenses/move`, alice.token, request, "POST", 404);
            await api(`${root}/${circle.id}/expenses/move`, outsider.token, request, "POST", 404);
            await api(`${root}/${circle.id}/expenses/move`, bob.token, { ...request, previous_updated: "old" }, "POST", 409);
            await api(`${root}/${circle.id}/expenses/move`, bob.token, { ...request, category: "Missing category" }, "POST", 400);
            assert.equal((await api(`${personal}/${own.id}`, bob.token)).amount, own.amount);
            const before = await detail();
            const results = await Promise.all([api(`${root}/${circle.id}/expenses/move`, bob.token, request), api(`${root}/${circle.id}/expenses/move`, bob.token, request)]);
            moved = results[0];
            assert.equal(moved.id, own.id);
            assert.equal(results[1].id, own.id);
            assert.equal(moved.paid_by, bobMember);
            assert.equal(moved.created_by, bobMember);
            assert.equal(moved.expand.category.name, category);
            assert.equal(moved.source, own.source);
            assert.equal(moved.origin_expense, own.id);
            for (const field of ["amount", "currency", "notes", "payment_method", "occurred_at", "created", "updated"]) assert.equal(moved[field], own[field], field);
            assert.deepEqual(moved.shares, [{ member: bobMember, amount: 1234, percentage_bp: 10000 }]);
            assert.deepEqual((await detail()).balances, before.balances);
            await api(`${personal}/${own.id}`, bob.token, undefined, "GET", 404);
            await api(`${personal}/${own.id}`, bob.token, { amount: 3, moved_to: "" }, "PATCH", 404);
            await api(`${personal}/${own.id}`, bob.token, undefined, "DELETE", 404);
            assert.equal((await api(personal, bob.token)).totalItems, 0);
            const afterMove = await api(`/api/expenditure/overview?${query}`, bob.token);
            assert.equal(afterMove.total, baseline.total + own.amount);
            assert.equal(afterMove.count, baseline.count + 1);
            const ownerMember = (await detail()).me;
            const edit = { title: moved.title, kind: "expense", recurrence: "", amount: moved.amount, currency: moved.currency, category: moved.category, paid_by: bobMember, split_mode: "even", shares: [{ member: bobMember }, { member: ownerMember }], occurred_at: personalData.occurred_at, version: moved.version };
            const resplit = await api(`${root}/${circle.id}/expenses/${moved.id}`, bob.token, edit, "PATCH");
            assert.equal((await detail()).balances.find((row) => row.member === bobMember && row.currency === "SGD").net, 617);
            assert.equal((await api(`/api/expenditure/overview?${query}`, bob.token)).total, baseline.total + 617);
            await api(`${root}/${circle.id}/expenses/${moved.id}`, bob.token, { ...edit, split_mode: "percentage", shares: [{ member: bobMember, percentage_bp: 10000 }], version: resplit.version }, "PATCH");
            await api(`${root}/${otherCircle.id}/expenses/move`, alice.token, request, "POST", 404);
            const income = await api(personal, bob.token, { ...personalData, kind: "income" });
            await api(`${root}/${circle.id}/expenses/move`, bob.token, { ...request, expense: income.id, previous_updated: income.updated }, "POST", 400);
            const tamper = await api(personal, bob.token, { ...personalData, moved_to: own.id, moved_circle: circle.id });
            assert.equal(tamper.moved_to, "");
        });
        await t.test("moving retains JPY and KWD minor units even if the personal currency is now disabled", async () => {
            const config = await api("/api/expenditure/config", bob.token);
            const prefs = `/api/collections/preferences/records/${config.preferences.id}`;
            await api(prefs, bob.token, { currencies: [...config.preferences.currencies, "JPY", "KWD"] }, "PATCH");
            const rows = [];
            for (const [currency, amount] of [["JPY", 1001], ["KWD", 1234]]) rows.push(await api(personal, bob.token, { ...personalData, currency, amount }));
            await api(prefs, bob.token, { currencies: config.preferences.currencies }, "PATCH");
            for (const row of rows) {
                const result = await api(`${root}/${circle.id}/expenses/move`, bob.token, { expense: row.id, previous_updated: row.updated, category: await activeCategory() });
                assert.equal(result.currency, row.currency);
                assert.equal(result.amount, row.amount);
                assert.equal(result.shares[0].amount, row.amount);
            }
        });
        await t.test("moving a recurring original transfers its exact schedule without moving prior occurrences", async () => {
            const prior = await api(personal, bob.token, { ...personalData, merchant: "Prior occurrence", occurred_at: "2090-01-01T04:00:00Z" });
            const seed = await api(personal, bob.token, { ...personalData, merchant: "Subscription", recurrence: "monthly", recurrence_interval: 2, recurrence_day: 31, occurred_at: "2090-01-02T04:00:00Z" });
            const shared = await api(`${root}/${circle.id}/expenses/move`, bob.token, { expense: seed.id, previous_updated: seed.updated, category: await activeCategory() });
            for (const field of ["recurrence", "recurrence_interval", "recurrence_day", "recurrence_weekdays", "recurrence_month", "recurrence_anchor", "recurrence_timezone", "recurrence_next"]) assert.deepEqual(shared[field], seed[field]);
            await api("/api/test/recurrence", admin, { now: Date.parse("2090-03-31T04:00:00Z") });
            assert.equal((await api(`${personal}/${prior.id}`, bob.token)).id, prior.id);
            assert.equal((await api(`${personal}?perPage=100`, bob.token)).items.filter((row) => row.merchant === "Subscription").length, 0);
            const entries = (await detail()).expenses.items.filter((row) => row.title === "Subscription");
            assert.equal(entries.length, 3);
            assert.ok(entries.every((row) => row.category === shared.category && row.shares[0].member === bobMember));
            assert.equal(entries.filter((row) => row.recurrence).length, 1);
        });
        await t.test("API retry markers survive a move, Circle entry deletion and expiry", async () => {
            const key = await api("/api/expenditure/keys", bob.token, { name: "Move check", scopes: ["expenses:read", "expenses:write"], expires_at: "" }, "POST", 201);
            const body = { merchant: "API move", amount: 350, currency: "SGD", category: "Other", occurred_at: personalData.occurred_at };
            async function automation(payload, expected, idempotency = "move-once") {
                const response = await fetch(base + "/api/expenses/transactions", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key.key, "Idempotency-Key": idempotency }, body: JSON.stringify(payload) });
                const data = await response.json();
                assert.equal(response.status, expected, JSON.stringify(data));
                return data;
            }

            const original = await automation(body, 201);
            const result = await api(`${root}/${circle.id}/expenses/move`, bob.token, { expense: original.id, previous_updated: original.updated, category: await activeCategory() });
            assert.equal(result.source, "api");
            const retry = await automation(body, 200);
            assert.equal(retry.id, original.id);
            assert.equal(retry.replay, true);
            assert.equal(retry.moved_to, result.id);
            await automation({ ...body, amount: 351 }, 409);
            const read = await fetch(base + "/api/expenses/transactions?perPage=100", { headers: { "X-API-Key": key.key } }).then((response) => response.json());
            assert.ok(!read.items.some((row) => row.id === original.id));
            await api(`${root}/${circle.id}/expenses/${result.id}`, bob.token, { version: result.version }, "DELETE");
            await api(`${root}/${circle.id}/expenses/move`, bob.token, { expense: original.id, previous_updated: original.updated, category: result.category }, "POST", 409);
            assert.equal((await automation(body, 200)).id, original.id);
            await api("/api/test/age", admin, { id: original.id, created: new Date(Date.now() - 25 * 3600000).toISOString().replace("T", " ") });
            assert.notEqual((await automation(body, 201)).id, original.id);
            const separate = await api(root, bob.token, { name: "Delete transfer test", icon: "users", currency: "SGD" }, "POST", 201);
            const next = await automation(body, 201, "deleted-circle");
            await api(`${root}/${separate.id}/expenses/move`, bob.token, { expense: next.id, previous_updated: next.updated, category: "Other" });
            await api(`${root}/${separate.id}`, bob.token, { confirmation: separate.name, version: separate.version }, "DELETE");
            await api(`${personal}/${next.id}`, bob.token, undefined, "GET", 404);
            assert.equal((await automation(body, 200, "deleted-circle")).id, next.id);
        });
        await t.test("revoked membership blocks moves and category changes", async () => {
            const own = await api(personal, bob.token, personalData);
            await api(`${root}/${circle.id}/members/${bobMember}`, alice.token, undefined, "DELETE");
            await api(`${root}/${circle.id}/expenses/move`, bob.token, { expense: own.id, previous_updated: own.updated, category: "Food & drinks" }, "POST", 404);
            await api(`${categoryPath}/copy`, bob.token, { previous_ids: (await detail()).categories.filter((row) => row.kind === "expense").map((row) => row.id) }, "POST", 404);
            assert.equal((await api(`${personal}/${own.id}`, bob.token)).id, own.id);
        });
    },
);
