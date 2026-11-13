import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Receipt expenses persist calculations and enforce ledger permissions", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-receipts-"));
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const hooks = join(directory, "hooks");
    await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
    await writeFile(join(hooks, "test.pb.js"), `routerAdd("POST", "/api/test/receipt-recurrence", (e) => {
        require(__hooks + "/recurrence.js").run(e.app, e.requestInfo().body.now);
        return e.json(200, {});
    }, $apis.requireAuth("_superusers"));`);
    const flags = [`--dir=${directory}`, `--hooksDir=${hooks}`, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`];
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
        const circle = await api(root, { token: owner.token, body: { name: "Receipt tests", currency }, expected: 201 });
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

    const g = await group();
    const receipt = { input_mode: "subtotals", items: [{ label: "Owner", amount: 2000, members: [g.ids.owner] }, { label: "Member", amount: 3000, members: [g.ids.member] }], discount: 0, service_rate_bp: 1000, service_amount: null, gst_mode: "added", gst_rate_bp: 900, gst_amount: null, adjustment: 0 };
    const input = { ...g.expenseInput, title: "Dinner receipt", amount: 5995, receipt, shares: [{ member: g.ids.owner, amount: 2398 }, { member: g.ids.member, amount: 3597 }] };
    let saved;
    await t.test("save and refresh retain all inputs and exact allocated shares", async () => {
        saved = await api(`${g.path}/expenses`, { token: owner.token, body: input, expected: 201 });
        assert.deepEqual(saved.receipt, receipt);
        assert.deepEqual(saved.shares, input.shares);
        const after = await api(g.path, { token: member.token });
        assert.deepEqual(after.expenses.items.find((item) => item.id === saved.id).receipt, receipt);
        assert.equal(after.balances.find((row) => row.member === g.ids.member).net, -4597);
    });
    await t.test("tampered totals, shares, membership and income cannot create receipts", async () => {
        for (const changes of [
            { amount: 5996, shares: [{ member: g.ids.owner, amount: 2399 }, { member: g.ids.member, amount: 3597 }] },
            { shares: [{ member: g.ids.owner, amount: 5995 }] },
            { split_mode: "even", shares: [{ member: g.ids.owner }, { member: g.ids.member }] },
            { kind: "income" }, { receipt: { ...receipt, discount: 5000 } },
            { receipt: { ...receipt, items: [{ label: "Outsider", amount: 5000, members: ["aaaaaaaaaaaaaaa"] }] } },
            { receipt: { ...receipt, unexpected: true } },
        ]) await api(`${g.path}/expenses`, { token: owner.token, body: { ...input, ...changes }, expected: 400 });
        assert.equal((await api(g.path, { token: owner.token })).expenses.totalItems, 2);
    });
    await t.test("receipt allocations require a signed-in session", async () => {
        await api(`${g.path}/expenses`, { body: input, expected: 401 });
        await api(`/api/collections/circle_expenses/records`, { token: owner.token, body: { ...input, circle: g.circle.id }, expected: 403 });
    });
    await t.test("only author and owner can edit and concurrent edits use versions", async () => {
        await api(`${g.path}/expenses/${saved.id}`, { token: member.token, method: "PATCH", body: { ...input, version: saved.version }, expected: 403 });
        await api(`${g.path}/expenses/${saved.id}`, { token: outsider.token, method: "PATCH", body: { ...input, version: saved.version }, expected: 404 });
        const original = saved;
        saved = await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...input, notes: "Checked receipt", version: saved.version } });
        assert.equal(saved.id, original.id);
        assert.equal(saved.created, original.created);
        assert.deepEqual(saved.receipt, receipt);
        await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...input, version: original.version }, expected: 409 });
    });
    await t.test("recurring receipt copies preserve the saved breakdown and exact amounts", async () => {
        const h = await group();
        const data = { ...receipt, items: [{ label: "Shared meal", amount: 5000, members: [h.ids.owner, h.ids.member] }], input_mode: "items" };
        const seed = await api(`${h.path}/expenses`, { token: owner.token, body: { ...input, paid_by: h.ids.owner, receipt: data, shares: [{ member: h.ids.owner, amount: 2998 }, { member: h.ids.member, amount: 2997 }].sort((a, b) => a.member.localeCompare(b.member)).map((row, index) => ({ member: row.member, amount: index === 0 ? 2998 : 2997 })), recurrence: "daily", occurred_at: "2090-01-01T04:00:00Z" }, expected: 201 });
        await api("/api/test/receipt-recurrence", { token: admin, body: { now: Date.parse("2090-01-03T04:00:00Z") } });
        const rows = (await api(h.path, { token: owner.token })).expenses.items.filter((row) => row.title === input.title);
        assert.equal(rows.length, 3);
        assert.equal(rows.filter((row) => row.recurrence).length, 1);
        for (const row of rows) {
            assert.deepEqual(row.receipt, data);
            assert.deepEqual(row.shares, seed.shares);
            assert.equal(row.amount, seed.amount);
        }
    });
    await t.test("former member balances remain protected, while notes edits retain the receipt", async () => {
        await api(`${g.path}/settlements`, { token: member.token, body: { from_member: g.ids.member, to_member: g.ids.owner, currency: "SGD", amount: 4597 }, expected: 201 });
        await api(`${g.path}/members/${g.ids.member}`, { token: owner.token, method: "DELETE" });
        saved = await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...input, notes: "Historical receipt", version: saved.version } });
        const changed = { ...receipt, service_amount: 0, gst_amount: 0 };
        await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...input, receipt: changed, amount: 5000, shares: [{ member: g.ids.owner, amount: 2000 }, { member: g.ids.member, amount: 3000 }], version: saved.version }, expected: 400 });
        const before = await api(g.path, { token: owner.token });
        const { receipt: omitted, ...withoutReceipt } = input;
        saved = await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...withoutReceipt, notes: "Retained when omitted", version: saved.version } });
        assert.deepEqual(saved.receipt, omitted);
        saved = await api(`${g.path}/expenses/${saved.id}`, { token: owner.token, method: "PATCH", body: { ...input, receipt: null, version: saved.version } });
        assert.equal(saved.receipt, null);
        assert.deepEqual((await api(g.path, { token: owner.token })).balances, before.balances);
    });
});
