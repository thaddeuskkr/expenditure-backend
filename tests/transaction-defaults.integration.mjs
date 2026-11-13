import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import themes from "../pocketbase/pb_hooks/theme-core.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Personal transaction defaults persist, validate ownership and preserve ledger behavior", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-defaults-"));
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
        ({ path, body } = await resolveCategoryFixture(base, path, body, token));
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

    const owner = await user("Defaults"), outsider = await user("Outsider");
    const config = () => api("/api/expenditure/config", { token: owner.token });
    const initial = await config();
    const path = `/api/collections/preferences/records/${initial.preferences.id}`;
    const save = (body, expected = 200) => api(path, { token: owner.token, method: "PATCH", body, expected });
    const categories = initial.categories;
    const expenseCategory = categories.find((category) => category.name === "Food & drinks");
    const incomeCategory = categories.find((category) => category.kind === "income" && category.name === "Other");
    const outsiderCategory = (await api("/api/expenditure/config", { token: outsider.token })).categories[0];
    const entry = await api("/api/collections/expenses/records", { token: owner.token, body: {
        user: owner.id, merchant: "Existing entry", amount: 650, currency: "SGD", category: "Other", occurred_at: "2026-10-29T04:05:06Z", payment_method: "Cash", notes: "Preserved",
    } });
    await t.test("fresh accounts have empty defaults and native creation preserves them", async () => {
        for (const field of ["default_entry_currency", "default_expense_category", "default_income_category"])
            assert.equal(initial.preferences[field], "");
        const fresh = await api("/api/collections/users/records", { token: admin, body: { email: "native@example.com", password, passwordConfirm: password } });
        const created = await api("/api/collections/preferences/records", { token: admin, body: { user: fresh.id, currency: "SGD", currencies: ["SGD"], timezone: "Asia/Singapore" } });
        assert.deepEqual(initial.preferences.payment_methods, []);
        assert.deepEqual(created.payment_methods, []);
        assert.equal(created.default_entry_currency, "");
        assert.equal(created.default_expense_category, "");
        assert.equal(created.default_income_category, "");
    });
    await t.test("account themes persist across clients and reject unreadable or foreign writes", async () => {
        assert.equal(initial.preferences.theme.preset, "mauve");
        const before = await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token });
        for (const preset of themes.presets) {
            const theme = { preset: preset.id, colors: preset.colors };
            assert.deepEqual((await save({ theme })).theme, theme);
            assert.deepEqual((await config()).preferences.theme, theme);
        }

        const custom = { preset: "custom", colors: { ...themes.presets[1].colors, accent: "#aaccff" } };
        const expected = themes.normalizeTheme(custom);
        assert.deepEqual((await save({ theme: custom })).theme, expected);
        assert.deepEqual((await config()).preferences.theme, expected);
        // Separate sessions for the same account read the identical persisted value.
        const secondSession = await api("/api/collections/users/auth-with-password", { body: { identity: owner.email, password } });
        assert.deepEqual((await api("/api/expenditure/config", { token: secondSession.token })).preferences.theme, expected);
        await api(path, { token: outsider.token, method: "PATCH", body: { theme: custom }, expected: 404 });
        assert.equal((await api("/api/expenditure/config", { token: outsider.token })).preferences.theme.preset, "mauve");
        const invalid = [null, [], "mauve", {}, { ...custom, extra: true }, { ...custom, preset: "unknown" },
            { preset: "custom", colors: {} }, { ...custom, colors: { ...custom.colors, accent: "red" } },
            { ...custom, colors: { ...custom.colors, text: custom.colors.background } },
            { ...custom, colors: { ...custom.colors, muted: custom.colors.raised } },
            { ...custom, colors: { ...custom.colors, accent: custom.colors.surface } },
            { ...custom, colors: { ...custom.colors, extra: "#000000" } }];
        for (const theme of invalid) await save({ theme }, 400);
        assert.deepEqual((await config()).preferences.theme, expected);
        assert.deepEqual(await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token }), before);
        await save({ theme: initial.preferences.theme });
    });
    await t.test("payment choices persist, normalize and preserve historical labels", async () => {
        const before = await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token });
        assert.deepEqual((await save({ payment_methods: ["  Travel   Visa  ", "Joint account"] })).payment_methods, ["Travel Visa", "Joint account"]);
        assert.deepEqual((await config()).preferences.payment_methods, ["Travel Visa", "Joint account"]);
        await api(path, { token: outsider.token, method: "PATCH", body: { payment_methods: ["Foreign"] }, expected: 404 });
        assert.deepEqual((await api("/api/expenditure/config", { token: outsider.token })).preferences.payment_methods, []);
        for (const invalid of [null, "Visa", {}, [1], [""], ["  "], ["Visa", "visa"], [" Joint  account ", "Joint account"], ["x".repeat(81)], Array.from({ length: 51 }, (_, i) => `Card ${i}`)])
            await save({ payment_methods: invalid }, 400);
        assert.deepEqual((await config()).preferences.payment_methods, ["Travel Visa", "Joint account"]);
        await save({ payment_methods: ["Joint account", "Renamed Visa"] });
        assert.deepEqual((await config()).preferences.payment_methods, ["Joint account", "Renamed Visa"]);
        await save({ payment_methods: [] });
        assert.deepEqual((await config()).preferences.payment_methods, []);
        assert.deepEqual(await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token }), before);
        // Stored labels remain free text for existing entries and automation.
        const imported = await api("/api/collections/expenses/records", { token: owner.token, body: { user: owner.id, merchant: "External payment label", amount: 100, currency: "SGD", category: expenseCategory.id, occurred_at: "2026-10-29T04:05:06Z", payment_method: "External import method" } });
        const updated = await api(`/api/collections/expenses/records/${imported.id}`, { token: owner.token, method: "PATCH", body: { payment_method: "Another import method" } });
        assert.equal(updated.payment_method, "Another import method");
        await api(`/api/collections/expenses/records/${imported.id}`, { token: owner.token, method: "DELETE", expected: 204 });
    });
    await t.test("transactions and budgets reject a category from the other list", async () => {
        const token = owner.token;
        const personal = "/api/collections/expenses/records";
        const body = { user: owner.id, merchant: "Category check", amount: 100, currency: "SGD", occurred_at: "2026-10-29T04:05:06Z" };
        await api(personal, { token, body: { ...body, kind: "income", category: expenseCategory.id }, expected: 400 });
        await api(personal, { token, body: { ...body, kind: "expense", category: incomeCategory.id }, expected: 400 });
        await api(`${personal}/${entry.id}`, { token, method: "PATCH", body: { kind: "income" }, expected: 400 });
        await api("/api/collections/budgets/records", { token, body: { user: owner.id, month: "2026-10", amount: 100, currency: "SGD", category: incomeCategory.id }, expected: 400 });
    });
    await t.test("separate category IDs and an enabled entry currency survive reload", async () => {
        await save({ default_entry_currency: "USD", default_expense_category: expenseCategory.id, default_income_category: incomeCategory.id });
        const preferences = (await config()).preferences;
        assert.equal(preferences.default_entry_currency, "USD");
        assert.equal(preferences.currency, "SGD");
        assert.equal(preferences.default_expense_category, expenseCategory.id);
        assert.equal(preferences.default_income_category, incomeCategory.id);
        assert.deepEqual(await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token }), entry);
    });
    await t.test("invalid currencies and foreign, missing or archived categories are rejected", async () => {
        await save({ default_entry_currency: "XYZ" }, 400);
        await save({ default_entry_currency: "JPY" }, 400);
        for (const field of ["default_expense_category", "default_income_category"]) {
            await save({ [field]: outsiderCategory.id }, 400);
            await save({ [field]: "missing00000000" }, 400);
        }

        const archived = categories.find((category) => category.name === "Groceries");
        await api(`/api/expenditure/categories/${archived.id}`, { token: owner.token, method: "PATCH", body: { active: false } });
        await save({ default_expense_category: archived.id }, 400);
        await api(path, { token: outsider.token, method: "PATCH", body: { default_entry_currency: "EUR" }, expected: 404 });
        assert.equal((await config()).preferences.default_entry_currency, "USD");
    });
    await t.test("renaming preserves IDs and archiving clears only the matching default", async () => {
        await api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { name: "Meals" } });
        assert.equal((await config()).preferences.default_expense_category, expenseCategory.id);
        await save({ default_income_category: expenseCategory.id }, 400);
        await save({ default_expense_category: incomeCategory.id }, 400);
        await api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { active: false } });
        const preferences = (await config()).preferences;
        assert.equal(preferences.default_expense_category, "");
        assert.equal(preferences.default_income_category, incomeCategory.id);
        await api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { active: true } });
        assert.equal((await config()).preferences.default_expense_category, "");
        assert.deepEqual(await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token }), entry);
    });
    await t.test("disabling the preferred currency resets it without rewriting history", async () => {
        const preferences = await save({ currencies: ["SGD", "EUR"] });
        assert.equal(preferences.default_entry_currency, "");
        await save({ default_entry_currency: "EUR" });
        assert.equal((await save({ currency: "EUR" })).default_entry_currency, "EUR");
        await save({ default_entry_currency: "" });
        assert.equal((await config()).preferences.default_entry_currency, "");
        assert.deepEqual(await api(`/api/collections/expenses/records/${entry.id}`, { token: owner.token }), entry);
        await save({ currency: "SGD", currencies: ["SGD", "USD", "EUR"] });
    });
    await t.test("concurrent archiving and default selection cannot retain an archived category", async () => {
        for (let index = 0; index < 8; index++) {
            await api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { active: true } });
            const [selection] = await Promise.all([
                fetch(base + path, { method: "PATCH", headers: { Authorization: owner.token, "Content-Type": "application/json" }, body: JSON.stringify({ default_expense_category: expenseCategory.id }) }),
                api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { active: false } }),
            ]);
            assert.ok([200, 400].includes(selection.status), await selection.text());
            assert.equal((await config()).preferences.default_expense_category, "");
        }

        await api(`/api/expenditure/categories/${expenseCategory.id}`, { token: owner.token, method: "PATCH", body: { active: true } });
    });
});
