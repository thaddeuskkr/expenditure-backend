import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

test("Category relations and ledger moves", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-category-relations-"));
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
    async function api(path, { token, body, headers = {}, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        const response = await fetch(base + path, {
            method,
            headers: { ...headers, ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

    const owner = await user("Owner"), other = await user("Other");
    const config = (account = owner) => api("/api/expenditure/config", { token: account.token });
    const initial = await config();
    const categories = initial.categories;
    const food = categories.find((row) => row.name === "Food & drinks"), groceries = categories.find((row) => row.name === "Groceries");
    const circle = await api("/api/expenditure/circles", { token: owner.token, body: { name: "Shortcut destination", currency: "SGD" }, expected: 201 });
    const circlePath = `/api/expenditure/circles/${circle.id}`;
    const detail = () => api(circlePath, { token: owner.token });
    const shared = await detail();
    const circleFood = shared.categories.find((row) => row.name === "Food & drinks");
    const personalPath = "/api/collections/expenses/records";
    const personalInput = { user: owner.id, merchant: "App entry", amount: 650, currency: "SGD", category: food.id, occurred_at: "2026-10-29T04:05:06Z" };
    await t.test("stored categories are scoped relations, budgets allow Overall without a fake category, and duplicate retry fields are gone", async () => {
        for (const table of ["expenses", "budgets", "circle_expenses"]) {
            const schema = await api(`/api/collections/${table}`, { token: admin });
            const category = schema.fields.find((row) => row.name === "category");
            assert.equal(category.type, "relation");
            assert.equal(category.required, table !== "budgets");
            if (table === "expenses") {
                assert.ok(!schema.fields.some((row) => ["idempotency_key", "idempotency_data"].includes(row.name)));
                assert.ok(!schema.indexes.some((row) => row.includes("idx_expenses_idempotency")));
            }
        }

        const budget = { user: owner.id, month: "2026-10", currency: "SGD", amount: 10000, category: "" };
        await api("/api/collections/budgets/records", { token: owner.token, body: budget });
        await api("/api/collections/budgets/records", { token: owner.token, body: budget, expected: 400 });
        await api("/api/collections/budgets/records", { token: owner.token, body: { ...budget, category: "Overall" }, expected: 400 });
        await api("/api/collections/budgets/records", { token: owner.token, body: { ...budget, category: food.id } });
    });
    await t.test("session writes require owned category IDs", async () => {
        await api(personalPath, { token: owner.token, body: { ...personalInput, category: food.name }, expected: 400 });
        await api(personalPath, { token: owner.token, body: { ...personalInput, category: (await config(other)).categories[0].id }, expected: 400 });
        const personal = await api(personalPath, { token: owner.token, body: personalInput });
        assert.equal(personal.category, food.id);
    });
    await t.test("category renames preserve ledger timestamps and Circle versions, and open editors can still save", async () => {
        const personal = await api(personalPath + "?expand=category", { token: owner.token, body: personalInput });
        const budget = await api("/api/collections/budgets/records?expand=category", { token: owner.token, body: { user: owner.id, month: "2026-11", currency: "SGD", amount: 9000, category: food.id } });
        const payload = { title: "Open editor", amount: 1000, currency: "SGD", category: circleFood.id, paid_by: shared.me, split_mode: "even", shares: [{ member: shared.me }], occurred_at: "2091-01-01T04:00:00Z", recurrence: "monthly", recurrence_interval: 2, recurrence_day: 31 };
        const entry = await api(circlePath + "/expenses", { token: owner.token, body: payload, expected: 201 });
        await api(`/api/expenditure/categories/${food.id}`, { token: owner.token, method: "PATCH", body: { name: "Meals" } });
        await api(`${circlePath}/categories/${circleFood.id}`, { token: owner.token, method: "PATCH", body: { name: "Shared meals" } });
        const after = await api(`${personalPath}/${personal.id}?expand=category`, { token: owner.token });
        const afterBudget = await api(`/api/collections/budgets/records/${budget.id}?expand=category`, { token: owner.token });
        for (const field of ["category", "amount", "created", "updated", "occurred_at"]) assert.equal(after[field], personal[field]);
        assert.equal(after.expand.category.name, "Meals");
        assert.equal(afterBudget.updated, budget.updated);
        const current = (await detail()).expenses.items.find((row) => row.id === entry.id);
        for (const field of ["category", "version", "amount", "created", "updated", "recurrence_next", "recurrence_anchor", "recurrence_timezone"]) assert.equal(current[field], entry[field], field);
        assert.equal(current.expand.category.name, "Shared meals");
        const edited = await api(`${circlePath}/expenses/${entry.id}`, { token: owner.token, method: "PATCH", body: { ...payload, title: "Saved from open editor", version: entry.version } });
        assert.equal(edited.version, entry.version + 1);
        assert.equal(edited.category, circleFood.id);
        await api(`${circlePath}/expenses/${entry.id}`, { token: owner.token, method: "DELETE", body: { version: edited.version } });
    });
    await t.test("ledger moves carry category IDs across scopes while matching display names", async () => {
        const personal = await api(personalPath, { token: owner.token, body: { ...personalInput, category: groceries.id } });
        const circleGroceries = (await detail()).categories.find((row) => row.name === "Groceries");
        const moved = await api(`${circlePath}/expenses/move`, { token: owner.token, body: { expense: personal.id, previous_updated: personal.updated, category: circleGroceries.id } });
        assert.equal(moved.category, circleGroceries.id);
        const target = await api(`${circlePath}/expenses/${moved.id}/move-to-personal`, { token: owner.token, body: { version: moved.version } });
        assert.equal(target.category, groceries.id);
        assert.equal(target.expand.category.name, "Groceries");
        assert.equal(target.amount, personal.amount);
    });
    await t.test("query plans use the indexes for all-currency history, members and invitations", () => {
        const database = new DatabaseSync(join(directory, "data.db"));
        try {
            const cases = [
                ["SELECT id FROM expenses WHERE user = ? AND moved_to = '' AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, created DESC, id DESC LIMIT 15", [owner.id, "2026-01-01", "2027-01-01"], "idx_expenses_user_date"],
                ["SELECT id FROM circle_members WHERE circle = ? ORDER BY created,id", [circle.id], "idx_circle_members_circle_created"],
                ["SELECT id FROM circle_invitations WHERE circle = ? AND accepted_at = '' AND revoked_at = '' ORDER BY created DESC", [circle.id], "idx_circle_invitations_circle_created"],
            ];
            for (const [sql, args, index] of cases) {
                const plan = database.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((row) => row.detail).join(";");
                assert.ok(plan.includes(index), plan);
                assert.ok(!plan.includes("USE TEMP B-TREE"), plan);
            }
        } finally {
            database.close();
        }
    });
});
