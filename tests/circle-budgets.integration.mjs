import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Personal monthly spending and budgets include allocated Circle expenses", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-circle-budgets-"));
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
    async function api(path, { token, headers = {}, body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        ({ path, body } = await resolveCategoryFixture(base, path, body, token));
        const response = await fetch(base + path, {
            method,
            headers: { ...headers, ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const content = await response.text();
        const data = content ? JSON.parse(content) : null;
        assert.equal(response.status, expected, JSON.stringify({ path, data, body }) + (response.status >= 500 ? logs : ""));
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

    const root = "/api/expenditure/circles";
    let sequence = 0;
    async function group() {
        const index = sequence++;
        const owner = await user(`Owner${index}`), member = await user(`Member${index}`), other = await user(`Other${index}`);
        const circle = await api(root, { token: owner.token, body: { name: "Budget ledger", currency: "SGD" }, expected: 201 });
        const ids = { owner: (await api(`${root}/${circle.id}`, { token: owner.token })).me };
        for (const [name, account] of [["member", member], ["other", other]]) {
            const invitation = await api(`${root}/${circle.id}/invitations`, { token: owner.token, body: { email: account.email }, expected: 201 });
            ids[name] = (await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: account.token, body: {} })).member;
        }

        return { owner, member, other, circle, ids, path: `${root}/${circle.id}` };
    }

    const range = { from: "2026-09-30T16:00:00Z", to: "2026-10-31T16:00:00Z", previous: "2026-08-31T16:00:00Z", currency: "all" };
    const report = (account, changes = {}) => api(`/api/expenditure/overview?${new URLSearchParams({ ...range, ...changes })}`, { token: account.token });
    const detail = (g) => api(g.path, { token: g.owner.token });
    const create = (g, fields = {}) => api(`${g.path}/expenses`, { token: g.owner.token, expected: 201, body: {
        title: "Shared purchase", amount: 1000, currency: "SGD", category: "Other", paid_by: g.ids.owner,
        split_mode: "exact", shares: [{ member: g.ids.member, amount: 1000 }], occurred_at: "2026-10-15T04:00:00Z", ...fields,
    } });
    const category = (account, name) => api("/api/expenditure/categories", { token: account.token, body: { name, color: "#123456" }, expected: 201 });
    const circleCategory = (g, name) => api(`${g.path}/categories`, { token: g.owner.token, body: { name, color: "#654321" }, expected: 201 });
    const budget = (account, name, amount = 2000) => api("/api/collections/budgets/records", { token: account.token, body: { user: account.id, month: "2026-10", category: name, currency: "SGD", amount } });
    const personal = (account, fields = {}) => api("/api/collections/expenses/records", { token: account.token, body: {
        user: account.id, merchant: "Personal purchase", amount: 200, currency: "SGD", category: "Other", occurred_at: "2026-10-15T04:00:00Z", ...fields,
    } });
    const editInput = (entry, fields) => ({ title: entry.title, kind: entry.kind, amount: entry.amount, currency: entry.currency, category: entry.category, paid_by: entry.paid_by, split_mode: entry.split_mode, shares: entry.shares.map(({ member, amount }) => ({ member, amount })), occurred_at: new Date(entry.occurred_at.replace(" ", "T")).toISOString(), version: entry.version, ...fields });

    await t.test("native preference creation defaults on and respects an explicit opt-out", async () => {
        for (const include of [undefined, false]) {
            const account = await api("/api/collections/users/records", { token: admin, body: { email: `native-${include}@example.com`, password, passwordConfirm: password, verified: true } });
            const preferences = await api("/api/collections/preferences/records", { token: admin, body: {
                user: account.id, currency: "SGD", currencies: ["SGD"], timezone: "Asia/Singapore",
                ...(include === undefined ? {} : { include_circle_in_budgets: include }),
            } });
            assert.equal(preferences.include_circle_in_budgets, include === undefined);
        }
    });
    await t.test("Circle budgets default on and persist independently of transaction visibility and other accounts", async () => {
        const g = await group();
        const config = await api("/api/expenditure/config", { token: g.member.token });
        assert.equal(config.preferences.include_circle_in_budgets, true);
        assert.equal(config.preferences.show_circle_transactions, false);
        const path = `/api/collections/preferences/records/${config.preferences.id}`;
        await personal(g.member);
        await personal(g.member, { kind: "income", amount: 500 });
        const moved = await personal(g.member, { amount: 300 });
        await api(`${g.path}/expenses/move`, { token: g.member.token, body: { expense: moved.id, previous_updated: moved.updated, category: "Other" } });
        await create(g, { shares: [{ member: g.ids.member, amount: 800 }, { member: g.ids.owner, amount: 200 }] });
        await create(g, { occurred_at: "2026-09-15T04:00:00Z" });
        await create(g, { currency: "AED" });
        const ledger = await detail(g);
        assert.equal((await report(g.member)).total, 1300);
        for (const show_circle_transactions of [false, true]) {
            await api(path, { token: g.member.token, method: "PATCH", body: { include_circle_in_budgets: false, show_circle_transactions } });
            const saved = await api("/api/expenditure/config", { token: g.member.token });
            assert.equal(saved.preferences.include_circle_in_budgets, false);
            assert.equal(saved.preferences.show_circle_transactions, show_circle_transactions);
            await api(path, { token: g.member.token, method: "PATCH", body: { time_format: "12h" } });
            assert.equal((await api("/api/expenditure/config", { token: g.member.token })).preferences.include_circle_in_budgets, false);
            const summary = await report(g.member);
            assert.equal(summary.total, 200);
            assert.equal(summary.count, 1);
            assert.equal(summary.previous, 0);
            assert.equal(summary.income, 500);
            assert.equal(summary.missing_count, 0);
            assert.equal(summary.previous_missing_count, 0);
            assert.deepEqual(summary.missing_currencies, []);
            assert.deepEqual(summary.categories.map((row) => ({ category_name: row.category_name, total: row.total, count: row.count })), [{ category_name: "Other", total: 200, count: 1 }]);
            assert.deepEqual(summary.original_totals, [{ currency: "SGD", total: 200 }]);
            assert.equal(summary.activity.reduce((sum, row) => sum + row.total, 0), 200);
            assert.equal((await report(g.member, { currency: "AED" })).count, 0);
            assert.equal((await report(g.owner)).total, 200);
            await api(path, { token: g.member.token, method: "PATCH", body: { include_circle_in_budgets: true } });
            const enabled = await report(g.member);
            assert.equal(enabled.total, 1300);
            assert.equal(enabled.previous, 1000);
            assert.equal(enabled.missing_count, 1);
        }

        await api(path, { token: g.other.token, method: "PATCH", body: { include_circle_in_budgets: false }, expected: 404 });
        assert.equal((await api("/api/expenditure/config", { token: g.member.token })).preferences.include_circle_in_budgets, true);
        assert.deepEqual((await detail(g)).balances, ledger.balances);
        assert.deepEqual((await detail(g)).expenses, ledger.expenses);
    });
    await t.test("budgets use each user's allocation and canonical personal category rather than the payer total", async () => {
        const g = await group();
        await category(g.member, "Dining");
        await circleCategory(g, "dining");
        const limit = await budget(g.member, "Dining");
        await personal(g.member, { category: "Dining" });
        await create(g, { category: "dining", shares: [{ member: g.ids.owner, amount: 200 }, { member: g.ids.member, amount: 800 }] });
        const summary = await report(g.member);
        assert.equal(summary.total, 1000);
        assert.equal(summary.count, 2);
        assert.deepEqual(summary.categories.map((row) => ({ category_name: row.category_name, total: row.total, count: row.count })), [{ category_name: "Dining", total: 1000, count: 2 }]);
        assert.equal(limit.amount - summary.categories[0].total, 1000);
        assert.equal(summary.activity.reduce((sum, item) => sum + item.total, 0), 1000);
        assert.deepEqual(summary.original_totals, [{ currency: "SGD", total: 1000 }]);
        const owner = await report(g.owner);
        assert.equal(owner.total, 200);
        assert.deepEqual(owner.categories.map((row) => ({ category_name: row.category_name, total: row.total, count: row.count })), [{ category_name: "Other", total: 200, count: 1 }]);
        assert.equal((await report(g.other)).total, 0);
        assert.equal((await api("/api/collections/expenses/records", { token: g.member.token })).totalItems, 1);
        const schema = await api("/api/collections/circle_members", { token: admin });
        assert.ok(schema.indexes.some((index) => index.includes("idx_circle_members_user_circle")));
    });
    await t.test("case and whitespace matching respects archived categories and uses Other for unknown or ambiguous names", async () => {
        const g = await group();
        const travel = await category(g.member, "Travel");
        await budget(g.member, "Travel");
        await api(`/api/expenditure/categories/${travel.id}`, { token: g.member.token, method: "PATCH", body: { active: false } });
        for (const name of ["TRAVEL", "Circle only", "Food   &  drinks", "meals   out", "Meals  out", "constructor", "__proto__"]) await circleCategory(g, name);
        await category(g.member, "Meals out");
        await category(g.member, "Meals  out");
        await category(g.member, "constructor");
        for (const [name, amount] of [["TRAVEL", 100], ["Circle only", 200], ["Food   &  drinks", 300], ["meals   out", 400], ["Meals  out", 500], ["constructor", 600], ["__proto__", 700]]) {
            await create(g, { category: name, amount, shares: [{ member: g.ids.member, amount }] });
        }

        let summary = await report(g.member);
        const totals = Object.fromEntries(summary.categories.map((row) => [row.category_name, row.total]));
        assert.deepEqual(totals, { Other: 1300, constructor: 600, "Meals  out": 500, "Food & drinks": 300, Travel: 100 });
        const before = await api("/api/expenditure/config", { token: g.member.token });
        const other = before.categories.find((row) => row.name === "Other");
        await budget(g.member, "Other");
        await api(`/api/expenditure/categories/${other.id}`, { token: g.member.token, method: "PATCH", body: { name: "other" } });
        assert.equal((await report(g.member)).categories.find((row) => row.category_name === "other").total, 1300);
        await api(`/api/expenditure/categories/${other.id}`, { token: g.member.token, method: "PATCH", body: { name: "Miscellaneous" } });
        summary = await report(g.member);
        assert.equal(summary.categories.find((row) => row.category_name === "Other").total, 1300);
        const after = await api("/api/expenditure/config", { token: g.member.token });
        assert.ok(!after.categories.some((row) => row.kind === "expense" && ["Other", "Circle only", "TRAVEL"].includes(row.name)));
        assert.equal(after.categories.length, before.categories.length);
        assert.equal((await detail(g)).expenses.items.find((row) => row.amount === 200).expand.category.name, "Circle only");
    });
    await t.test("resplits, moves and direct API imports update consumption without copying or double counting", async () => {
        const g = await group();
        const own = await personal(g.member, { amount: 1000 });
        assert.equal((await report(g.member)).total, 1000);
        const moved = await api(`${g.path}/expenses/move`, { token: g.member.token, body: { expense: own.id, previous_updated: own.updated, category: "Other" } });
        assert.equal((await report(g.member)).total, 1000);
        assert.equal((await report(g.member)).count, 1);
        assert.equal((await api("/api/collections/expenses/records", { token: g.member.token })).totalItems, 0);
        await api(`${g.path}/expenses/${moved.id}`, { token: g.member.token, method: "PATCH", body: editInput(moved, { split_mode: "exact", shares: [{ member: g.ids.member, amount: 500 }, { member: g.ids.owner, amount: 500 }] }) });
        assert.equal((await report(g.member)).total, 500);
        assert.equal((await report(g.owner)).total, 500);
        let imported = await api(`${g.path}/expenses`, { token: g.member.token, headers: { "X-Expenditure-Source": "shortcut" }, body: { title: "Shortcut purchase", amount: 600, currency: "SGD", category: "Other", paid_by: g.ids.member, split_mode: "exact", shares: [{ member: g.ids.member, amount: 600 }], occurred_at: "2026-10-15T05:00:00Z" }, expected: 201 });
        assert.equal((await report(g.member)).total, 1100);
        imported = await api(`${g.path}/expenses/${imported.id}`, { token: g.member.token, method: "PATCH", body: editInput(imported, { split_mode: "exact", shares: [{ member: g.ids.owner, amount: 600 }] }) });
        assert.equal((await report(g.member)).total, 500);
        assert.equal((await report(g.owner)).total, 1100);
        assert.equal(imported.source, "shortcut");
        await api(`${g.path}/expenses/${imported.id}`, { token: g.member.token, method: "DELETE", body: { version: imported.version } });
        assert.equal((await report(g.owner)).total, 500);
    });
    await t.test("Circle income, repayments and zero allocations never consume budgets", async () => {
        const g = await group();
        await create(g);
        await create(g, { kind: "income", amount: 400, shares: [{ member: g.ids.member, amount: 400 }] });
        const repayment = await api(`${g.path}/settlements`, { token: g.member.token, body: { from_member: g.ids.member, to_member: g.ids.owner, currency: "SGD", amount: 200 }, expected: 201 });
        await personal(g.member, { kind: "income", amount: 500 });
        await create(g, { shares: [{ member: g.ids.member, amount: 0 }, { member: g.ids.other, amount: 1000 }] });
        let summary = await report(g.member);
        assert.equal(summary.total, 1000);
        assert.equal(summary.count, 1);
        assert.equal(summary.income, 500);
        assert.equal(summary.income_missing_count, 0);
        await api(`${g.path}/settlements/${repayment.id}`, { token: g.member.token, method: "PATCH", body: { from_member: repayment.from_member, to_member: repayment.to_member, currency: "SGD", amount: 300, version: repayment.version } });
        summary = await report(g.member);
        assert.equal(summary.total, 1000);
        assert.equal(summary.count, 1);
        const penny = await create(g, { amount: 1, split_mode: "even", shares: [{ member: g.ids.owner }, { member: g.ids.member }, { member: g.ids.other }] });
        for (const [name, account, baseline] of [["owner", g.owner, 0], ["member", g.member, 1000], ["other", g.other, 1000]]) {
            assert.equal((await report(account)).total, baseline + penny.shares.find((share) => share.member === g.ids[name]).amount);
        }
    });
    await t.test("historical allocations still count after leaving a Circle and are not duplicated when rejoining", async () => {
        const g = await group();
        await create(g);
        await api(`${g.path}/settlements`, { token: g.member.token, expected: 201, body: { from_member: g.ids.member, to_member: g.ids.owner, currency: "SGD", amount: 1000 } });
        await api(`${g.path}/members/${g.ids.member}`, { token: g.member.token, method: "DELETE" });
        await api(g.path, { token: g.member.token, expected: 404 });
        assert.equal((await report(g.member)).total, 1000);
        const config = await api("/api/expenditure/config", { token: g.member.token });
        const path = `/api/collections/preferences/records/${config.preferences.id}`;
        await api(path, { token: g.member.token, method: "PATCH", body: { include_circle_in_budgets: false } });
        assert.equal((await report(g.member)).total, 0);
        await api(path, { token: g.member.token, method: "PATCH", body: { include_circle_in_budgets: true } });
        const invitation = await api(`${g.path}/invitations`, { token: g.owner.token, body: { email: g.member.email }, expected: 201 });
        const joined = await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: g.member.token, body: {} });
        assert.equal(joined.member, g.ids.member);
        assert.equal((await report(g.member)).total, 1000);
        assert.equal((await report(g.member)).count, 1);
        await api(g.path, { token: g.owner.token, method: "DELETE", body: { confirmation: g.circle.name, version: g.circle.version } });
        assert.equal((await report(g.member)).total, 0);
    });
    await t.test("account month boundaries include current and previous Circle shares across daylight saving", async () => {
        const g = await group();
        const config = await api("/api/expenditure/config", { token: g.member.token });
        await api(`/api/collections/preferences/records/${config.preferences.id}`, { token: g.member.token, method: "PATCH", body: { timezone: "America/New_York" } });
        for (const [occurred_at, amount] of [["2026-10-31T23:59:59-04:00", 100], ["2026-11-01T00:00:00-04:00", 200], ["2026-11-30T23:59:59-05:00", 300], ["2026-12-01T00:00:00-05:00", 400]]) {
            await create(g, { occurred_at, amount, shares: [{ member: g.ids.member, amount }] });
        }

        const summary = await report(g.member, { previous: "2026-10-01T04:00:00Z", from: "2026-11-01T04:00:00Z", to: "2026-12-01T05:00:00Z" });
        assert.equal(summary.total, 500);
        assert.equal(summary.previous, 100);
        assert.equal(summary.count, 2);
        assert.equal(summary.activity.reduce((sum, row) => sum + row.total, 0), 500);
    });
    await t.test("reports aggregate every allocation beyond Circle and personal pagination", async () => {
        const g = await group();
        for (let index = 0; index < 41; index++) await create(g, { title: `Entry ${index}`, amount: 1, shares: [{ member: g.ids.member, amount: 1 }] });
        assert.equal((await detail(g)).expenses.items.length, 25);
        const summary = await report(g.member);
        assert.equal(summary.total, 41);
        assert.equal(summary.count, 41);
        assert.deepEqual(summary.categories.map((row) => ({ category_name: row.category_name, total: row.total, count: row.count })), [{ category_name: "Other", total: 41, count: 41 }]);
        assert.equal(summary.activity[0].total, 41);
        assert.equal((await report(g.owner)).total, 0);
    });
    await t.test("per-allocation currency conversion preserves precision, filters and stale/missing-rate warnings", async () => {
        const g = await group();
        const today = new Date().toISOString().slice(0, 10);
        const snapshot = { quotes: { EUR: 1, SGD: 1.5, USD: 1, JPY: 100, KWD: 0.3 }, dates: { SGD: today, USD: today, JPY: today, KWD: today }, fetched_at: new Date().toISOString(), attempted_at: new Date().toISOString() };
        await api("/api/collections/exchange_rates/records/fxlatest0000000", { token: admin, method: "PATCH", body: snapshot });
        for (const [currency, amount, occurred_at] of [["USD", 1, "2026-10-15T04:00:00Z"], ["USD", 1, "2026-10-15T05:00:00Z"], ["JPY", 650, "2026-10-15T04:00:00Z"], ["KWD", 1234, "2026-10-15T04:00:00Z"], ["AED", 100, "2026-10-15T04:00:00Z"], ["USD", 1, "2026-09-15T04:00:00Z"]]) {
            await create(g, { currency, amount, occurred_at, shares: [{ member: g.ids.member, amount }] });
        }

        await create(g, { currency: "AED", kind: "income", amount: 100, shares: [{ member: g.ids.member, amount: 100 }] });
        let summary = await report(g.member);
        assert.equal(summary.total, 4 + 975 + 617);
        assert.equal(summary.previous, 2);
        assert.equal(summary.count, 5);
        assert.equal(summary.missing_count, 1);
        assert.equal(summary.income_missing_count, 0);
        assert.deepEqual(summary.missing_currencies, ["AED"]);
        assert.equal(summary.original_totals.find((row) => row.currency === "KWD").total, 1234);
        assert.equal((await report(g.member, { currency: "JPY" })).total, 975);
        assert.equal((await report(g.member, { currency: "JPY" })).count, 1);
        const stale = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
        await api("/api/collections/exchange_rates/records/fxlatest0000000", { token: admin, method: "PATCH", body: { dates: { ...snapshot.dates, USD: stale } } });
        summary = await report(g.member, { currency: "USD" });
        assert.equal(summary.total, 0);
        assert.equal(summary.missing_count, 2);
        assert.equal(summary.previous_missing_count, 1);
        assert.deepEqual(summary.missing_currencies, ["USD"]);
    });
});
