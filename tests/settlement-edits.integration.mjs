import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Recorded repayment edits preserve permissions, ledger balances and recalculated suggestions", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-repayment-edits-"));
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const flags = [`--dir=${directory}`, `--hooksDir=${resolve("pocketbase/pb_hooks")}`, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`];
    const password = randomBytes(24).toString("hex");
    const setup = spawnSync(binary, ["superuser", "upsert", "admin@example.com", password, ...flags], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const server = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags], { stdio: ["ignore", "pipe", "pipe"] });
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
    const base = `http://127.0.0.1:${port}`;
    async function api(path, { token, body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        ({ path, body } = await resolveCategoryFixture(base, path, body, token));
        const response = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const content = await response.text();
        const data = content ? JSON.parse(content) : null;
        assert.equal(response.status, expected, JSON.stringify({ path, data }) + (response.status >= 500 ? logs : ""));
        return data;
    }

    for (let index = 0; index < 100; index++) {
        try {
            if ((await fetch(base + "/api/health")).ok) break;
        } catch {}

        if (index === 99) assert.fail(logs);
        await new Promise((done) => setTimeout(done, 25));
    }

    const admin = (await api("/api/collections/_superusers/auth-with-password", { body: { identity: "admin@example.com", password } })).token;
    async function user(name) {
        const record = await api("/api/collections/users/records", { token: admin, body: { email: `${name}@example.com`, name, password, passwordConfirm: password, verified: true } });
        const auth = await api("/api/collections/users/auth-with-password", { body: { identity: record.email, password } });
        await api("/api/expenditure/config", { token: auth.token });
        return { ...record, token: auth.token };
    }

    const owner = await user("Owner"), member = await user("Member"), carol = await user("Carol"), outsider = await user("Outsider");
    const root = "/api/expenditure/circles";
    async function group(currency = "SGD") {
        const circle = await api(root, { token: owner.token, body: { name: "Repayment edits", currency }, expected: 201 });
        const ids = { owner: (await api(`${root}/${circle.id}`, { token: owner.token })).me };
        for (const [name, account] of [["member", member], ["carol", carol]]) {
            const invitation = await api(`${root}/${circle.id}/invitations`, { token: owner.token, body: { email: account.email }, expected: 201 });
            ids[name] = (await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: account.token, body: {} })).member;
        }

        const path = `${root}/${circle.id}`;
        const expenseInput = { title: "Shared purchase", amount: 1000, currency, paid_by: ids.owner, split_mode: "exact", shares: [{ member: ids.member, amount: 1000 }] };
        const expense = await api(`${path}/expenses`, { token: owner.token, body: expenseInput, expected: 201 });
        return { circle, ids, path, expense, expenseInput };
    }

    const detail = (g) => api(g.path, { token: owner.token });
    const payment = (g, amount = 400, token = member.token) => api(`${g.path}/settlements`, {
        token, expected: 201,
        body: { from_member: g.ids.member, to_member: g.ids.owner, currency: g.circle.currency, amount, notes: "Original note", occurred_at: "2026-10-27T12:30:00+08:00" },
    });
    const input = (record, changes = {}) => ({ from_member: record.from_member, to_member: record.to_member, currency: record.currency, amount: record.amount, version: record.version, ...changes });
    const update = (g, record, changes = {}, token = member.token, expected = 200) => api(`${g.path}/settlements/${record.id}`, { token, method: "PATCH", body: input(record, changes), expected });
    const suggestion = (g, amount, currency = g.circle.currency) => ({ from_member: g.ids.member, to_member: g.ids.owner, currency, amount });

    await t.test("editing partial and fully settled repayments recalculates the remaining suggestion", async () => {
        const g = await group();
        const original = await payment(g);
        assert.deepEqual((await detail(g)).suggestions, [suggestion(g, 600)]);
        let current = original;
        for (const [amount, remaining] of [[200, 800], [700, 300], [1000, 0], [400, 600]]) {
            current = await update(g, current, { amount });
            assert.equal(current.id, original.id);
            assert.equal(current.created_by, original.created_by);
            assert.equal(current.created, original.created);
            assert.equal(current.occurred_at, original.occurred_at);
            assert.equal(current.notes, original.notes);
            assert.deepEqual((await detail(g)).suggestions, remaining ? [suggestion(g, remaining)] : []);
            assert.equal((await detail(g)).settlements.totalItems, 1);
        }

        assert.equal(current.version, original.version + 4);
        await update(g, original, { amount: 300 }, member.token, 409);
        const after = await update(g, current, { notes: "Corrected note", occurred_at: "2026-10-28T03:45:00-04:00" });
        assert.equal(after.notes, "Corrected note");
        assert.equal(Date.parse(after.occurred_at), Date.parse("2026-10-28T07:45:00Z"));
        assert.deepEqual((await detail(g)).suggestions, [suggestion(g, 600)]);
    });
    await t.test("only the original author or owner can edit, with current versions and a user session", async () => {
        const g = await group();
        const record = await payment(g);
        await update(g, record, { amount: 300 }, carol.token, 403);
        await update(g, record, { amount: 300 }, outsider.token, 404);
        const other = await group();
        await api(`${other.path}/settlements/${record.id}`, { token: owner.token, method: "PATCH", body: input(record), expected: 404 });
        await api(`${g.path}/settlements/${record.id}`, { method: "PATCH", body: input(record), expected: 401 });
        for (const version of [undefined, "1", 0, record.version + 1]) await update(g, record, { version }, member.token, 409);
        const owned = await update(g, record, { amount: 250 }, owner.token);
        assert.equal(owned.created_by, record.created_by);
        assert.equal(owned.created, record.created);
        const recordedByOwner = await payment(g, 100, owner.token);
        await update(g, recordedByOwner, { amount: 50 }, member.token, 403);
    });
    await t.test("invalid replacements and overpayments roll back without changing the ledger", async () => {
        const g = await group();
        const record = await payment(g);
        const before = await detail(g);
        for (const changes of [
            { amount: 1001 }, { amount: 0 }, { amount: -1 }, { amount: 1.1 }, { amount: "500" },
            { currency: "JPY" }, { currency: "BAD" }, { from_member: g.ids.owner },
            { to_member: "aaaaaaaaaaaaaaa" }, { notes: "x".repeat(1001) }, { notes: null },
            { occurred_at: "2026-10-28T12:00:00" }, { occurred_at: "2026-02-30T12:00:00Z" },
            { created_by: g.ids.owner }, { circle: g.circle.id }, { unknown: true },
        ]) await update(g, record, changes, member.token, 400);
        const after = await detail(g);
        assert.deepEqual(after.settlements, before.settlements);
        assert.deepEqual(after.balances, before.balances);
        assert.deepEqual(after.suggestions, before.suggestions);
    });
    await t.test("an original recorder retains metadata access after ownership transfer", async () => {
        const g = await group();
        await api(`${g.path}/expenses`, { token: owner.token, body: { ...g.expenseInput, paid_by: g.ids.carol }, expected: 201 });
        let record = await api(`${g.path}/settlements`, { token: owner.token, expected: 201, body: { from_member: g.ids.member, to_member: g.ids.carol, currency: "SGD", amount: 200 } });
        await api(g.path, { token: owner.token, method: "PATCH", body: { owner: carol.id, version: g.circle.version } });
        record = await update(g, record, { notes: "Receipt correction" }, owner.token);
        assert.equal(record.created_by, g.ids.owner);
        await update(g, record, { amount: 250 }, owner.token, 403);
        await update(g, record, { amount: 250 }, carol.token);
    });
    await t.test("participant and currency corrections reverse the old entry in its original currency", async () => {
        const g = await group();
        await api(`${g.path}/expenses`, { token: owner.token, body: { ...g.expenseInput, currency: "JPY", amount: 1234, shares: [{ member: g.ids.member, amount: 1234 }] }, expected: 201 });
        await api(`${g.path}/expenses`, { token: owner.token, body: { ...g.expenseInput, currency: "KWD", amount: 1234, shares: [{ member: g.ids.carol, amount: 1234 }] }, expected: 201 });
        let record = await payment(g);
        record = await update(g, record, { currency: "JPY", amount: 234 });
        let after = await detail(g);
        assert.ok(after.suggestions.some((row) => row.currency === "SGD" && row.amount === 1000));
        assert.ok(after.suggestions.some((row) => row.currency === "JPY" && row.amount === 1000));
        await update(g, record, { currency: "KWD", from_member: g.ids.carol, amount: 1234 }, member.token, 403);
        record = await update(g, record, { currency: "KWD", from_member: g.ids.carol, amount: 1234 }, owner.token);
        assert.equal(record.created_by, g.ids.member);
        after = await detail(g);
        assert.ok(!after.suggestions.some((row) => row.currency === "KWD"));
        assert.ok(after.suggestions.some((row) => row.currency === "JPY" && row.amount === 1234));
    });
    await t.test("later ledger changes do not block notes or date corrections on historical repayments", async () => {
        const g = await group();
        let record = await payment(g, 600);
        await api(`${g.path}/expenses/${g.expense.id}`, { token: owner.token, method: "PATCH", body: { ...g.expenseInput, amount: 200, shares: [{ member: g.ids.member, amount: 200 }], version: g.expense.version } });
        const before = await detail(g);
        record = await update(g, record, { notes: "Historical correction", occurred_at: "2026-10-26T04:00:00Z" });
        const after = await detail(g);
        assert.deepEqual(after.balances, before.balances);
        assert.deepEqual(after.suggestions, before.suggestions);
        assert.equal(record.amount, 600);
        await update(g, record, { amount: 700 }, member.token, 400);
        await update(g, record, { amount: 100 });
        assert.deepEqual((await detail(g)).suggestions, [suggestion(g, 100)]);
    });
    await t.test("concurrent edits reject stale versions and concurrent repayments cannot overpay", async () => {
        const g = await group();
        let record = await payment(g);
        async function race(body, method, path = `${g.path}/settlements/${record.id}`) {
            const response = await fetch(base + path, { method, headers: { Authorization: member.token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return { status: response.status, data: await response.json() };
        }

        const edits = await Promise.all([300, 400].map((amount) => race(input(record, { amount }), "PATCH")));
        assert.deepEqual(edits.map((result) => result.status).sort(), [200, 409]);
        record = await update(g, edits.find((result) => result.status === 200).data, { amount: 400 });
        const results = await Promise.all([
            race(input(record, { amount: 800 }), "PATCH"),
            race({ from_member: record.from_member, to_member: record.to_member, currency: record.currency, amount: 400 }, "POST", `${g.path}/settlements`),
        ]);
        assert.equal(results.filter((result) => [200, 201].includes(result.status)).length, 1);
        assert.equal(results.filter((result) => result.status === 400).length, 1);
        const after = await detail(g);
        assert.equal(after.settlements.items.reduce((sum, row) => sum + row.amount, 0), 800);
        assert.deepEqual(after.suggestions, [suggestion(g, 200)]);
    });
    await t.test("former member financial history is protected while metadata remains editable", async () => {
        const g = await group();
        let record = await payment(g, 1000);
        await api(`${g.path}/members/${g.ids.member}`, { token: owner.token, method: "DELETE" });
        await update(g, record, { amount: 900 }, owner.token, 400);
        await update(g, record, { notes: "Cannot access after leaving" }, member.token, 404);
        record = await update(g, record, { notes: "Corrected receipt" }, owner.token);
        assert.equal(record.created_by, g.ids.member);
        assert.equal(record.amount, 1000);
        assert.deepEqual((await detail(g)).suggestions, []);
        await api(`/api/collections/users/records/${member.id}`, { token: admin, method: "DELETE", expected: 204 });
        record = await update(g, record, { notes: "Preserved after account deletion" }, owner.token);
        assert.equal(record.from_member, g.ids.member);
        assert.deepEqual((await detail(g)).suggestions, []);
    });
});
