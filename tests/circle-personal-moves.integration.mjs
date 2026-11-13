import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Circle transactions move atomically into an authorized personal ledger", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-circle-personal-"));
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const hooks = join(directory, "hooks");
    await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
    await writeFile(join(hooks, "test.pb.js"), `routerAdd("POST", "/api/test/move-recurrence", (e) => {
        require(__hooks + "/recurrence.js").run(e.app, e.requestInfo().body.now);
        return e.json(200, {});
    }, $apis.requireAuth("_superusers"));`);
    await writeFile(join(hooks, "pause.pb.js"), `routerAdd("POST", "/api/test/pause-move", (e) => {
        e.app.db().newQuery("UPDATE circle_expenses SET recurrence_error = 'Resolve this first' WHERE id = {:id}").bind(e.requestInfo().body).execute();
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

    const owner = await user("Owner"), payer = await user("Payer"), member = await user("Member"), outsider = await user("Outsider");
    const root = "/api/expenditure/circles", personalRoot = "/api/collections/expenses/records";
    const config = (account = payer) => api("/api/expenditure/config", { token: account.token });
    async function group(currency = "SGD") {
        const circle = await api(root, { token: owner.token, body: { name: "Transfer tests", currency }, expected: 201 });
        const ids = { owner: (await api(`${root}/${circle.id}`, { token: owner.token })).me };
        for (const [name, account] of [["payer", payer], ["member", member]]) {
            const invite = await api(`${root}/${circle.id}/invitations`, { token: owner.token, body: { email: account.email }, expected: 201 });
            ids[name] = (await api(`/api/expenditure/circle-invitations/${invite.id}/accept`, { token: account.token, body: {} })).member;
        }

        const target = (await api(`${root}/${circle.id}`, { token: owner.token })).members.find((row) => row.id === ids.payer);
        await api(`${root}/${circle.id}/members/${ids.payer}/permissions`, { token: owner.token, method: "PATCH", body: { is_admin: false, can_add: true, edit_scope: "all", delete_scope: "own", move_scope: "payer", version: target.version } });
        return { circle, ids, path: `${root}/${circle.id}` };
    }

    function input(g, overrides = {}) {
        return { title: "Shared purchase", kind: "expense", amount: 1000, currency: g.circle.currency, category: "Other", paid_by: g.ids.payer, split_mode: "even", shares: [{ member: g.ids.payer }, { member: g.ids.member }], occurred_at: "2026-10-29T04:05:06.789Z", payment_method: "Saved card", notes: "Keep this note", ...overrides };
    }

    const create = (g, overrides = {}, author = owner) => api(`${g.path}/expenses`, { token: author.token, body: input(g, overrides), expected: 201 });
    const movePath = (g, expense) => `${g.path}/expenses/${expense.id}/move-to-personal`;
    const move = (g, expense, options = {}) => api(movePath(g, expense), { token: payer.token, body: { version: expense.version }, ...options });
    const detail = (g) => api(g.path, { token: owner.token });
    const balance = (d, id, currency = "SGD") => d.balances.find((row) => row.member === id && row.currency === currency)?.net || 0;
    await t.test("payer-scoped moves require an active payer with Move access", async () => {
        const g = await group(), expense = await create(g);
        assert.equal(expense.created_by, g.ids.owner);
        await move(g, expense, { token: undefined, expected: 401 });
        await move(g, expense, { token: member.token, expected: 403 });
        await move(g, expense, { token: outsider.token, expected: 404 });
        for (const field of ["user", "paid_by", "amount", "currency", "shares", "source"])
            await move(g, expense, { body: { version: expense.version, [field]: "spoof" }, expected: 400 });
        await move(g, expense, { body: { version: expense.version + 1 }, expected: 409 });
        const result = await move(g, expense);
        assert.equal(result.user, payer.id);
        assert.equal(result.amount, expense.amount);
        assert.equal((await detail(g)).expenses.totalItems, 0);
    });
    await t.test("expenses and income transfer the full charge for every split mode, including zero own share", async () => {
        const g = await group();
        for (const kind of ["expense", "income"]) {
            for (const [split_mode, shares] of [["even", [{ member: g.ids.payer }, { member: g.ids.member }]], ["percentage", [{ member: g.ids.payer, percentage_bp: 1000 }, { member: g.ids.member, percentage_bp: 9000 }]], ["exact", [{ member: g.ids.payer, amount: 0 }, { member: g.ids.member, amount: 1000 }]]]) {
                const expense = await create(g, { kind, split_mode, shares });
                const result = await move(g, expense);
                assert.notEqual(result.id, expense.id);
                assert.equal(result.merchant, expense.title);
                assert.equal(result.kind, kind);
                assert.equal(result.amount, 1000);
                for (const field of ["currency", "payment_method", "notes", "occurred_at", "source", "created", "updated"]) assert.equal(result[field], expense[field], field);
                assert.equal(result.shares, undefined);
                assert.equal(result.moved_to, "");
                assert.equal(result.moved_circle, "");
                assert.equal(balance(await detail(g), g.ids.member), 0);
                assert.equal((await api(`${personalRoot}/${result.id}`, { token: payer.token })).amount, 1000);
            }
        }
    });
    await t.test("category matching is active, exact then normalized, with Other and first-active fallbacks", async () => {
        const g = await group();
        const custom = await api("/api/expenditure/categories", { token: payer.token, body: { name: "Travel costs", color: "#123456" }, expected: 201 });
        const circleCategory = await api(`${g.path}/categories`, { token: owner.token, body: { name: "  TRAVEL   costs  ", color: "#234567" }, expected: 201 });
        const normalized = await move(g, await create(g, { category: circleCategory.name }));
        assert.equal(normalized.expand.category.name, custom.name);
        const exact = await move(g, await create(g, { category: "Food & drinks" }));
        assert.equal(exact.expand.category.name, "Food & drinks");
        await api(`/api/expenditure/categories/${custom.id}`, { token: payer.token, method: "PATCH", body: { active: false } });
        assert.equal((await move(g, await create(g, { category: circleCategory.name }))).expand.category.name, "Other");
        const expense = await create(g);
        const foreign = (await config(member)).categories[0];
        await move(g, expense, { body: { version: expense.version, category: foreign.id }, expected: 400 });
        await move(g, expense, { body: { version: expense.version, category: custom.name }, expected: 400 });
        assert.equal((await move(g, expense, { body: { version: expense.version, category: "Transport" } })).expand.category.name, "Transport");
        const other = (await config()).categories.find((item) => item.name === "Other");
        await api(`/api/expenditure/categories/${other.id}`, { token: payer.token, method: "PATCH", body: { active: false } });
        const first = (await config()).categories.find((item) => item.active);
        assert.equal((await move(g, await create(g))).expand.category.name, first.name);
        await api(`/api/expenditure/categories/${other.id}`, { token: payer.token, method: "PATCH", body: { active: true } });
    });
    await t.test("disabled zero- and three-decimal currencies preserve their integer values", async () => {
        for (const [currency, amount] of [["JPY", 650], ["KWD", 1234]]) {
            assert.ok(!(await config()).preferences.currencies.includes(currency));
            const g = await group(currency), expense = await create(g, { amount });
            const result = await move(g, expense);
            assert.equal(result.currency, currency);
            assert.equal(result.amount, amount);
            assert.ok(!(await config()).preferences.currencies.includes(currency));
        }
    });
    await t.test("concurrent moves create one entry; retries return 404 without altering or recreating it", async () => {
        const g = await group(), expense = await create(g);
        const before = (await api(personalRoot, { token: payer.token })).totalItems;
        const results = await Promise.all(Array.from({ length: 8 }, async () => {
            const response = await fetch(base + movePath(g, expense), {
                method: "POST", headers: { Authorization: payer.token, "Content-Type": "application/json" }, body: JSON.stringify({ version: expense.version }),
            });
            return { status: response.status, data: await response.json() };
        }));
        assert.equal(results.filter((row) => row.status === 200).length, 1);
        assert.equal(results.filter((row) => row.status === 404).length, 7, JSON.stringify(results));
        const target = results.find((row) => row.status === 200).data;
        assert.equal((await api(personalRoot, { token: payer.token })).totalItems, before + 1);
        await api(`${personalRoot}/${target.id}`, { token: payer.token, method: "PATCH", body: { notes: "Edited after moving" } });
        await move(g, expense, { expected: 404 });
        await move(g, expense, { body: { version: expense.version, category: "Other" }, expected: 404 });
        await move(g, expense, { token: owner.token, expected: 404 });
        assert.equal((await api(`${personalRoot}/${target.id}`, { token: payer.token })).notes, "Edited after moving");
        await api(`${personalRoot}/${target.id}`, { token: payer.token, method: "DELETE", expected: 204 });
        await move(g, expense, { expected: 404 });
        assert.equal((await api(personalRoot, { token: payer.token })).totalItems, before);
        assert.equal((await detail(g)).expenses.totalItems, 0);
        await api("/api/collections/circle_personal_moves", { token: admin, expected: 404 });
    });
    await t.test("former-member balance changes roll back the entire move", async () => {
        const g = await group(), expense = await create(g);
        await api(`/api/collections/circle_members/records/${g.ids.member}`, { token: admin, method: "PATCH", body: { active: false } });
        const before = await detail(g);
        const personalCount = (await api(personalRoot, { token: payer.token })).totalItems;
        await move(g, expense, { expected: 400 });
        assert.deepEqual((await detail(g)).balances, before.balances);
        assert.equal((await detail(g)).expenses.totalItems, 1);
        assert.equal((await api(personalRoot, { token: payer.token })).totalItems, personalCount);
        await api(`/api/collections/circle_members/records/${g.ids.payer}`, { token: admin, method: "PATCH", body: { active: false } });
        await move(g, expense, { expected: 404 });
    });
    await t.test("recorded repayments remain and suggestions follow the remaining ledger", async () => {
        const g = await group(), expense = await create(g, { split_mode: "exact", shares: [{ member: g.ids.member, amount: 1000 }] });
        const repayment = await api(`${g.path}/settlements`, { token: member.token, body: { from_member: g.ids.member, to_member: g.ids.payer, amount: 1000, currency: "SGD", notes: "Already paid", occurred_at: "2026-10-29T05:00:00Z" }, expected: 201 });
        assert.equal(balance(await detail(g), g.ids.payer), 0);
        await move(g, expense);
        const after = await detail(g);
        assert.deepEqual(after.settlements.items.find((row) => row.id === repayment.id), repayment);
        assert.equal(balance(after, g.ids.payer), -1000);
        assert.equal(balance(after, g.ids.member), 1000);
        assert.deepEqual(after.suggestions, [{ from_member: g.ids.payer, to_member: g.ids.member, currency: "SGD", amount: 1000 }]);
    });
    await t.test("active and paused recurrence checkpoints transfer without generating or moving earlier history", async () => {
        const preferences = (await config(owner)).preferences;
        await api(`/api/collections/preferences/records/${preferences.id}`, { token: owner.token, method: "PATCH", body: { timezone: "America/New_York" } });
        const g = await group();
        const seed = await create(g, { title: "Subscription", occurred_at: "2091-01-01T14:00:00Z", recurrence: "monthly", recurrence_interval: 2, recurrence_day: 31 });
        await api("/api/test/move-recurrence", { token: admin, body: { now: Date.parse("2091-01-31T14:00:00Z") } });
        const current = (await detail(g)).recurring.find((row) => row.id === seed.id);
        const history = (await detail(g)).expenses.items.filter((row) => row.id !== seed.id);
        assert.equal(history.length, 1);
        await api("/api/test/pause-move", { token: admin, body: { id: seed.id } });
        const paused = (await detail(g)).recurring.find((row) => row.id === seed.id);
        const moved = await move(g, paused);
        for (const field of ["recurrence", "recurrence_interval", "recurrence_day", "recurrence_weekdays", "recurrence_month", "recurrence_timezone", "recurrence_anchor", "recurrence_next", "recurrence_error"]) assert.deepEqual(moved[field], paused[field], field);
        assert.equal(moved.recurrence_error, "Resolve this first");
        assert.equal(moved.recurrence_next, current.recurrence_next);
        await api("/api/test/move-recurrence", { token: admin, body: { now: Date.parse("2091-03-31T14:00:00Z") } });
        assert.deepEqual((await detail(g)).expenses.items, history);
        const active = await create(g, { kind: "income", title: "Recurring income", occurred_at: "2092-01-01T14:00:00Z", recurrence: "weekly", recurrence_interval: 2, recurrence_weekdays: [1, 3, 5] });
        const transferred = await move(g, active);
        for (const field of ["recurrence_timezone", "recurrence_anchor", "recurrence_next", "recurrence_weekdays", "recurrence_interval"]) assert.deepEqual(transferred[field], active[field]);
        await api("/api/test/move-recurrence", { token: admin, body: { now: Date.parse(active.recurrence_next.replace(" ", "T")) } });
        const rows = (await api(personalRoot + "?perPage=100", { token: payer.token })).items.filter((row) => row.merchant === active.title);
        assert.equal(rows.length, 2);
        assert.equal(rows.filter((row) => row.recurrence).length, 1);
        assert.ok(rows.every((row) => row.kind === "income" && row.amount === active.amount));
    });
    await t.test("receipt totals transfer intact without retaining Circle splits or breakdowns", async () => {
        const g = await group();
        const receipt = { input_mode: "subtotals", items: [{ label: "Payer", amount: 2000, members: [g.ids.payer] }, { label: "Member", amount: 3000, members: [g.ids.member] }], discount: 0, service_rate_bp: 1000, service_amount: null, gst_mode: "added", gst_rate_bp: 900, gst_amount: null, adjustment: 0 };
        const expense = await create(g, { title: "Dinner receipt", amount: 5995, split_mode: "exact", receipt, shares: [{ member: g.ids.payer, amount: 2398 }, { member: g.ids.member, amount: 3597 }] });
        const result = await move(g, expense);
        assert.equal(result.amount, 5995);
        assert.equal(result.receipt, undefined);
        assert.deepEqual((await detail(g)).balances, []);
    });
    await t.test("reports and combined feeds count the full personal entry without a remaining Circle allocation", async () => {
        const g = await group();
        for (const account of [payer, member]) {
            const preferences = (await config(account)).preferences;
            await api(`/api/collections/preferences/records/${preferences.id}`, { token: account.token, method: "PATCH", body: { show_circle_transactions: true, include_circle_in_budgets: true } });
        }

        const expense = await create(g, { split_mode: "exact", shares: [{ member: g.ids.member, amount: 1000 }] });
        const query = new URLSearchParams({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", previous: "2026-09-01T00:00:00Z", currency: "SGD" });
        const summary = (account) => api(`/api/expenditure/overview?${query}`, { token: account.token });
        const before = { payer: await summary(payer), member: await summary(member) };
        const moved = await move(g, expense);
        assert.equal((await summary(payer)).total, before.payer.total + 1000);
        assert.equal((await summary(member)).total, before.member.total - 1000);
        for (const account of [payer, member]) {
            const feed = await api(`/api/expenditure/transactions?${query}&perPage=100`, { token: account.token });
            assert.ok(!feed.items.some((row) => row.id === expense.id));
            assert.equal(feed.items.filter((row) => row.id === moved.id).length, account === payer ? 1 : 0);
        }
    });
    await t.test("personal-to-Circle round trips retain immutable old move markers", async () => {
        const g = await group();
        const original = await api(personalRoot, { token: payer.token, body: {
            user: payer.id, merchant: "Round trip purchase", amount: 1234, currency: "SGD",
            category: "Other", occurred_at: "2026-10-29T04:05:06Z",
        } });
        const shared = await api(`${g.path}/expenses/move`, { token: payer.token, body: { expense: original.id, previous_updated: original.updated, category: "Other" } });
        const tombstone = await api(`${personalRoot}/${original.id}`, { token: admin });
        const returned = await move(g, shared);
        assert.notEqual(returned.id, original.id);
        assert.deepEqual(await api(`${personalRoot}/${original.id}`, { token: admin }), tombstone);
        await api(`${personalRoot}/${original.id}`, { token: payer.token, method: "PATCH", body: { moved_to: "" }, expected: 404 });
        const again = await api(`${g.path}/expenses/move`, { token: payer.token, body: { expense: returned.id, previous_updated: returned.updated, category: "Other" } });
        await move(g, shared, { expected: 404 });
        await move(g, again);
        assert.equal((await detail(g)).expenses.totalItems, 0);
    });
});
