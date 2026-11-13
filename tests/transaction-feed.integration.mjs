import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("The optional combined transaction feed preserves allocation, filtering and user isolation", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-transaction-feed-"));
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
    async function api(path, { token, key, body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        ({ path, body } = await resolveCategoryFixture(base, path, body, token));
        const response = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: token } : {}), ...(key ? { "X-API-Key": key } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

    const feed = (account, changes = {}, expected = 200) => api(`/api/expenditure/transactions?${new URLSearchParams({ ...range, ...changes })}`, { token: account.token, expected });
    async function setting(account, value) {
        const config = await api("/api/expenditure/config", { token: account.token });
        return api(`/api/collections/preferences/records/${config.preferences.id}`, { token: account.token, method: "PATCH", body: { show_circle_transactions: value } });
    }

    await t.test("the preference defaults off, persists independently and protects cross-user writes", async () => {
        const g = await group();
        const config = await api("/api/expenditure/config", { token: g.member.token });
        assert.equal(config.preferences.show_circle_transactions, false);
        await create(g);
        await personal(g.member);
        await budget(g.member, "Other");
        const before = await report(g.member);
        assert.equal((await feed(g.member)).totalItems, 1);
        await setting(g.member, true);
        assert.equal((await feed(g.member)).totalItems, 2);
        assert.equal((await api("/api/expenditure/config", { token: g.owner.token })).preferences.show_circle_transactions, false);
        await api(`/api/collections/preferences/records/${config.preferences.id}`, { token: g.other.token, method: "PATCH", body: { show_circle_transactions: true }, expected: 404 });
        await setting(g.member, false);
        assert.equal((await feed(g.member)).totalItems, 1);
        assert.deepEqual({ ...await report(g.member), rates_fetched_at: before.rates_fetched_at }, before);
        await api(`/api/expenditure/transactions?${new URLSearchParams(range)}`, { expected: 401 });
        const key = await api("/api/expenditure/keys", { token: g.member.token, body: { name: "Not a session", scopes: ["expenses:read"], expires_at: "" }, expected: 201 });
        await api(`/api/expenditure/transactions?${new URLSearchParams(range)}`, { key: key.key, expected: 401 });
    });
    await t.test("one globally ordered and paginated list includes only positive own shares, including income", async () => {
        const g = await group();
        await setting(g.member, true);
        const native = await personal(g.member);
        const shared = await create(g, { amount: 1000, shares: [{ member: g.ids.member, amount: 400 }, { member: g.ids.owner, amount: 600 }] });
        await create(g, { title: "Payer without allocation", paid_by: g.ids.member, shares: [{ member: g.ids.owner, amount: 1000 }] });
        await create(g, { title: "Zero allocation", shares: [{ member: g.ids.member, amount: 0 }, { member: g.ids.owner, amount: 1000 }] });
        const income = await create(g, { kind: "income", title: "Shared income", amount: 500, shares: [{ member: g.ids.member, amount: 500 }] });
        for (let index = 0; index < 38; index++) await create(g, { title: `Shared ${index}`, amount: 1, shares: [{ member: g.ids.member, amount: 1 }] });
        const whole = await feed(g.member, { perPage: "100" });
        assert.equal(whole.totalItems, 41);
        const pages = [];
        for (let page = 1; page <= 3; page++) pages.push(...(await feed(g.member, { page: String(page) })).items);
        assert.deepEqual(pages, whole.items);
        assert.equal(new Set(pages.map((row) => row.collectionName + row.id)).size, 41);
        const row = pages.find((row) => row.id === shared.id);
        assert.equal(row.amount, 1000);
        assert.equal(row.allocated_amount, 400);
        assert.equal(row.collectionName, "circle_expenses");
        assert.equal(row.circle, g.circle.id);
        assert.deepEqual(row.expand.circle, { id: g.circle.id, name: g.circle.name, icon: g.circle.icon });
        assert.equal(row.membership_active, true);
        assert.ok(!row.expand.user);
        assert.ok(pages.find((row) => row.id === income.id).kind === "income");
        assert.equal(pages.find((row) => row.id === native.id).collectionName, "expenses");
        assert.equal((await feed(g.member, { page: "99" })).items.length, 0);
        await setting(g.other, true);
        assert.equal((await feed(g.other, { user: g.member.id })).totalItems, 0);
        const unrelated = await group();
        await create(unrelated);
        assert.equal((await feed(g.member)).totalItems, 41);
    });
    await t.test("category, currency and literal searches apply before pagination across both ledgers", async () => {
        const g = await group();
        await setting(g.member, true);
        await category(g.member, "Dining");
        await circleCategory(g, "dining");
        await circleCategory(g, "Circle only");
        await personal(g.member, { category: "Dining", merchant: "Lunch 50% _ 'quoted'", payment_method: "Solo Visa" });
        await create(g, { title: "Dinner", category: "dining", notes: "Receipt note", payment_method: "Shared Visa" });
        await create(g, { title: "Ride", category: "Circle only", currency: "JPY" });
        assert.equal((await feed(g.member, { category: "Dining", perPage: "1" })).totalItems, 2);
        const other = await feed(g.member, { category: "Other" });
        assert.equal(other.totalItems, 1);
        assert.equal(other.items[0].expand.category.name, "Circle only");
        assert.equal(other.items[0].budget_category_name, "Other");
        await feed(g.member, { category: "Missing" }, 400);
        assert.equal((await feed(g.member, { currency: "JPY" })).totalItems, 1);
        assert.equal((await feed(g.member, { search: "visa" })).totalItems, 2);
        assert.equal((await feed(g.member, { search: "receipt NOTE" })).totalItems, 1);
        assert.equal((await feed(g.member, { search: "Budget ledger" })).totalItems, 2);
        assert.equal((await feed(g.member, { search: "50% _ 'quoted'" })).totalItems, 1);
        assert.equal((await feed(g.member, { search: "%" })).totalItems, 1);
        assert.equal((await feed(g.member, { search: "' OR 1=1 --" })).totalItems, 0);
        const config = await api("/api/expenditure/config", { token: g.member.token });
        assert.ok(config.used_currencies.includes("JPY"));
        await setting(g.member, false);
        assert.ok(!(await api("/api/expenditure/config", { token: g.member.token })).used_currencies.includes("JPY"));
    });
    await t.test("moves, split edits and deletes are reflected without duplicated receipts or balance changes", async () => {
        const g = await group();
        await setting(g.member, true);
        const own = await personal(g.member, { amount: 1000 });
        let moved = await api(`${g.path}/expenses/move`, { token: g.member.token, body: { expense: own.id, previous_updated: own.updated, category: "Other" } });
        assert.equal((await feed(g.member)).totalItems, 1);
        assert.equal((await feed(g.member)).items[0].allocated_amount, 1000);
        const before = (await detail(g)).balances;
        await feed(g.member);
        assert.deepEqual((await detail(g)).balances, before);
        moved = await api(`${g.path}/expenses/${moved.id}`, { token: g.member.token, method: "PATCH", body: editInput(moved, { split_mode: "exact", shares: [{ member: g.ids.member, amount: 400 }, { member: g.ids.owner, amount: 600 }] }) });
        assert.equal((await feed(g.member)).items[0].allocated_amount, 400);
        await api(`${g.path}/expenses/${moved.id}`, { token: g.member.token, method: "DELETE", body: { version: moved.version } });
        assert.equal((await feed(g.member)).totalItems, 0);
    });
    await t.test("historical allocations remain available after leaving and are not duplicated when rejoining", async () => {
        const g = await group();
        await setting(g.member, true);
        await create(g);
        await api(`${g.path}/settlements`, { token: g.member.token, expected: 201, body: { from_member: g.ids.member, to_member: g.ids.owner, currency: "SGD", amount: 1000 } });
        await api(`${g.path}/members/${g.ids.member}`, { token: g.member.token, method: "DELETE" });
        const history = await feed(g.member);
        assert.equal(history.totalItems, 1);
        assert.equal(history.items[0].membership_active, false);
        const invitation = await api(`${g.path}/invitations`, { token: g.owner.token, body: { email: g.member.email }, expected: 201 });
        await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: g.member.token, body: {} });
        assert.equal((await feed(g.member)).totalItems, 1);
        assert.equal((await feed(g.member)).items[0].membership_active, true);
    });
    await t.test("explicit timezone boundaries and input limits are enforced", async () => {
        const g = await group();
        await setting(g.member, true);
        for (const [occurred_at, amount] of [["2026-10-31T23:59:59-04:00", 100], ["2026-11-01T00:00:00-04:00", 200], ["2026-11-30T23:59:59-05:00", 300], ["2026-12-01T00:00:00-05:00", 400]]) await create(g, { occurred_at, amount, shares: [{ member: g.ids.member, amount }] });
        const result = await feed(g.member, { from: "2026-11-01T04:00:00Z", to: "2026-12-01T05:00:00Z" });
        assert.equal(result.totalItems, 2);
        assert.equal(result.items.reduce((sum, row) => sum + row.allocated_amount, 0), 500);
        for (const changes of [{ from: "" }, { from: "2026-10-01T00:00:00" }, { to: "2026-09-01T00:00:00Z" }, { to: "2027-10-01T00:00:00Z" }, { currency: "BOGUS" }, { page: "0" }, { page: "1.5" }, { perPage: "101" }, { search: "x".repeat(201) }]) await feed(g.member, changes, 400);
    });
    await t.test("amount sorting uses displayed shares and currency units before pagination in both ledgers", async () => {
        const g = await group();
        const config = await api("/api/expenditure/config", { token: g.member.token });
        await api(`/api/collections/preferences/records/${config.preferences.id}`, { token: g.member.token, method: "PATCH",
            body: { show_circle_transactions: true, currencies: ["SGD", "JPY", "KWD"] } });
        for (let index = 0; index < 27; index++) {
            const occurred_at = `2026-10-${String(28 - index).padStart(2, "0")}T04:00:00Z`;
            await personal(g.member, { merchant: `Amount personal ${index}`, amount: (28 - index) * 100, occurred_at });
            await create(g, { title: `Amount shared ${index}`, amount: (100 + index) * 1000, occurred_at,
                shares: [{ member: g.ids.member, amount: (index + 1) * 50 }, { member: g.ids.owner, amount: (100 + index) * 1000 - (index + 1) * 50 }] });
        }

        await personal(g.member, { merchant: "Amount yen", currency: "JPY", amount: 1000 });
        await personal(g.member, { merchant: "Amount dinar", currency: "KWD", amount: 12345 });
        await personal(g.member, { merchant: "Amount SGD precision", currency: "SGD", amount: 1234 });
        const displayed = (row) => (row.allocated_amount ?? row.amount) * ({ JPY: 1000, KWD: 1 }[row.currency] || 10);
        for (const sort of ["amount_desc", "amount_asc"]) {
            const all = await feed(g.member, { sort, perPage: "100" });
            assert.equal(all.totalItems, 57);
            const values = all.items.map(displayed);
            assert.deepEqual(values, [...values].sort((a, b) => sort === "amount_desc" ? b - a : a - b));
            const paged = [];
            for (let page = 1; page <= Math.ceil(all.totalItems / 7); page++)
                paged.push(...(await feed(g.member, { sort, perPage: "7", page: String(page) })).items);
            assert.deepEqual(paged, all.items, "Every page preserves the same complete sorted order and stable ties");
            const precision = all.items.filter((row) => ["Amount dinar", "Amount SGD precision"].includes(row.merchant));
            assert.equal(precision[0].merchant, sort === "amount_desc" ? "Amount dinar" : "Amount SGD precision");
        }

        const high = await feed(g.member, { sort: "amount_desc", perPage: "1" });
        assert.equal(high.items[0].merchant, "Amount yen", "JPY 1000 sorts above SGD 28 despite its smaller raw minor-unit value");
        const low = await feed(g.member, { sort: "amount_asc", perPage: "1" });
        assert.equal(low.items[0].title, "Amount shared 0", "The combined feed sorts the own share, not the much larger Circle total");
        const filtered = await feed(g.member, { sort: "amount_desc", currency: "SGD", search: "Amount personal", perPage: "1" });
        assert.equal(filtered.totalItems, 27);
        assert.equal(filtered.items[0].merchant, "Amount personal 0");
        await setting(g.member, false);
        assert.equal((await feed(g.member, { sort: "amount_asc", perPage: "100" })).totalItems, 30);
        await feed(g.member, { sort: "amount DESC; DROP TABLE expenses" }, 400);
        const oldest = await feed(g.member, { sort: "date_asc", perPage: "100" });
        assert.deepEqual(oldest.items.map((row) => row.occurred_at), oldest.items.map((row) => row.occurred_at).sort());
        const before = await detail(g);
        for (const sort of ["amount_desc", "amount_asc"]) {
            const query = { expense_sort: sort, expense_from: range.from, expense_to: range.to, expense_search: "Amount shared", expense_currency: "SGD" };
            const first = await api(`${g.path}?${new URLSearchParams(query)}`, { token: g.owner.token });
            const second = await api(`${g.path}?${new URLSearchParams({ ...query, expense_page: "2" })}`, { token: g.owner.token });
            const items = [...first.expenses.items, ...second.expenses.items];
            assert.equal(items.length, 27);
            assert.equal(new Set(items.map((row) => row.id)).size, 27);
            assert.equal(first.expenses.totalItems, 27);
            assert.deepEqual(items.map((row) => row.amount), items.map((row) => row.amount).sort((a, b) => sort === "amount_desc" ? b - a : a - b));
            assert.equal(items[0].title, sort === "amount_desc" ? "Amount shared 26" : "Amount shared 0");
            assert.deepEqual(first.balances, before.balances);
            assert.deepEqual(first.totals, before.totals);
            assert.deepEqual(first.settlements, before.settlements);
        }

        await api(`${g.path}?expense_sort=unsupported`, { token: g.owner.token, expected: 400 });
        await api(`${g.path}?expense_sort=amount_desc`, { token: g.other.token });
        const outside = await user("SortOutside");
        await api(`${g.path}?expense_sort=amount_desc`, { token: outside.token, expected: 404 });
    });
});
