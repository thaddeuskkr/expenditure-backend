import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";

for (const cutoff of ["1793206800_recurring_income_schedules.js", "1793293200_recurrence_calendar_choices.js", "1793296800_circle_budget_preference.js", "1793300400_immutable_api_retries.js", "1793383200_api_transaction_retries.js", "1793386800_default_api_workspace.js", "1793394000_api_settings_navigation.js", "1793397600_circle_personal_moves.js", "1793401200_category_relations_and_indexes.js", "1793404800_remove_circle_personal_moves.js", "1793408400_circle_member_permissions.js", "1793412000_circle_move_permissions.js", "1794442800_separate_transaction_categories.js"]) test(`schedule upgrade from ${cutoff} preserves active and paused cursors, records, identities and Circle balances`, { timeout: 30000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-schedule-upgrade-"));
    const oldMigrations = join(directory, "old-migrations"), oldHooks = join(directory, "old-hooks"), data = join(directory, "data");
    await mkdir(oldMigrations);
    await mkdir(oldHooks);
    for (const file of await readdir(resolve("pocketbase/pb_migrations"))) {
        if (file.endsWith(".js") && file < cutoff)
            await copyFile(resolve("pocketbase/pb_migrations", file), join(oldMigrations, file));
    }

    for (const file of ["currencies.json", "timezones.json"])
        await copyFile(resolve("pocketbase/pb_hooks", file), join(oldHooks, file));
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const base = `http://127.0.0.1:${port}`;
    const oldFlags = [`--dir=${data}`, `--migrationsDir=${oldMigrations}`, `--hooksDir=${oldHooks}`];
    const newFlags = [`--dir=${data}`, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`, `--hooksDir=${resolve("pocketbase/pb_hooks")}`];
    const password = randomBytes(24).toString("hex");
    const setup = spawnSync(binary, ["superuser", "upsert", "admin@example.com", password, ...oldFlags], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    let server, logs = "";
    async function stop() {
        if (server && server.exitCode === null && server.signalCode === null) {
            const exited = new Promise((done) => server.once("exit", done));
            server.kill("SIGTERM");
            await exited;
        }
    }

    t.after(async () => {
        await stop();
        await rm(directory, { recursive: true, force: true });
    });
    async function start(flags) {
        server = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags], { stdio: ["ignore", "pipe", "pipe"] });
        server.stdout.on("data", (chunk) => {
            logs += chunk;
        });
        server.stderr.on("data", (chunk) => {
            logs += chunk;
        });
        for (let index = 0; index < 100; index++) {
            try {
                if ((await fetch(base + "/api/health")).ok) return;
            } catch {}

            if (server.exitCode !== null) assert.fail(logs);
            await new Promise((done) => setTimeout(done, 30));
        }

        assert.fail(logs);
    }

    async function api(path, token, body, method = body === undefined ? "GET" : "POST") {
        if (method === "GET" && /^\/api\/collections\/(expenses|budgets|circle_expenses)\/records/.test(path)) path += (path.includes("?") ? "&" : "?") + "expand=category";
        const response = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const content = await response.text();
        const result = content ? JSON.parse(content) : null;
        assert.ok(response.ok, JSON.stringify({ path, result }) + logs);
        return result;
    }

    await start(oldFlags);
    const admin = (await api("/api/collections/_superusers/auth-with-password", null, { identity: "admin@example.com", password })).token;
    await api("/api/collections/users", admin, { oauth2: { enabled: true, providers: [{ name: "oidc", displayName: "Existing provider", clientId: "upgrade-test", clientSecret: "disposable-test-secret", authURL: "https://identity.example.com/authorize", tokenURL: "https://identity.example.com/token", userInfoURL: "https://identity.example.com/userinfo" }] } }, "PATCH");
    const identity = await api("/api/collections/users", admin);
    const user = await api("/api/collections/users/records", admin, { email: "schedule@example.com", name: "Schedule owner", password, passwordConfirm: password, verified: true });
    let prefs = await api("/api/collections/preferences/records", admin, { user: user.id, currency: "SGD", currencies: ["SGD"], timezone: "America/New_York", default_tab: cutoff === "1793394000_api_settings_navigation.js" ? "API keys" : "Transactions", time_format: "12h", show_circle_transactions: true });
    const category = await api("/api/collections/categories/records", admin, { user: user.id, name: "Other", active: true, color: "#123456", sort_order: 0 });
    const savedSecret = "exp_" + randomBytes(24).toString("hex");
    const splitUpgrade = cutoff === "1794442800_separate_transaction_categories.js";
    const savedKey = cutoff === "1793394000_api_settings_navigation.js" ?
            await api("/api/collections/api_keys/records", admin, {
                user: user.id, name: "Existing integration", key_hash: createHash("sha256").update(savedSecret).digest("hex"), key_prefix: savedSecret.slice(0, 12), scopes: ["expenses:read"], expires_at: "2099-01-01T00:00:00Z",
            }) :
        null;
    const relations = cutoff > "1793401200_category_relations_and_indexes.js";
    const fields = { user: user.id, merchant: "Existing schedule", kind: "expense", amount: 650, currency: "SGD", category: relations ? category.id : "Other", payment_method: "Saved card", source: "manual", notes: "Keep this", occurred_at: "2091-01-31T14:00:00Z", recurrence: "monthly", recurrence_interval: 2, recurrence_day: 0, recurrence_weekdays: [], recurrence_month: 0, recurrence_anchor: "2091-01-31T09:00:00", recurrence_timezone: "America/New_York", recurrence_next: "2091-02-28T14:00:00.000Z" };
    const active = await api("/api/collections/expenses/records", admin, fields);
    const paused = await api("/api/collections/expenses/records", admin, { ...fields, merchant: "Paused schedule", recurrence_error: "Resolve this first" });
    const weekly = await api("/api/collections/expenses/records", admin, { ...fields, merchant: "Existing weekly", recurrence: "weekly", recurrence_anchor: "2091-01-31T09:00:00", recurrence_next: "2091-02-07T14:00:00.000Z" });
    const yearly = await api("/api/collections/expenses/records", admin, { ...fields, merchant: "Existing yearly", recurrence: "yearly", recurrence_next: "2092-01-31T14:00:00.000Z" });
    const income = await api("/api/collections/expenses/records", admin, { ...fields, kind: "income", merchant: "Existing income", recurrence: "", recurrence_anchor: "", recurrence_timezone: "", recurrence_next: "" });
    const retryInput = { merchant: "Existing API purchase", amount: 650, currency: "SGD", category: "Other", notes: "Accepted request", payment_method: "Saved card", occurred_at: "2091-01-31T14:00:00.000Z" };
    const apiExpense = await api("/api/collections/expenses/records", admin, { ...retryInput, category: fields.category, user: user.id, source: "api", kind: "expense", recurrence_weekdays: [], idempotency_key: "upgrade-retry", idempotency_data: retryInput });
    if (cutoff > "1793383200_api_transaction_retries.js")
        await api("/api/collections/api_transaction_retries/records", admin, { user: user.id, key: "upgrade-retry", circle: "", transaction: apiExpense.id, request: retryInput, created: apiExpense.created });
    const circle = await api("/api/collections/circles/records", admin, { owner: user.id, name: "Existing circle", icon: "users", currency: "SGD", version: 2 });
    const memberPermissions = cutoff > "1793408400_circle_member_permissions.js" ? { is_admin: false, can_add: true, edit_scope: "own", delete_scope: "own", version: 1, ...(splitUpgrade ? { move_scope: "payer" } : {}) } : {};
    const payer = await api("/api/collections/circle_members/records", admin, { ...memberPermissions, circle: circle.id, user: user.id, name: user.name, active: true });
    const former = await api("/api/collections/circle_members/records", admin, { ...memberPermissions, circle: circle.id, name: "Former member", active: false });
    const restricted = cutoff > "1793408400_circle_member_permissions.js" ? await api("/api/collections/circle_members/records", admin, { ...memberPermissions, circle: circle.id, name: "Restricted historical member", active: false, edit_scope: "none", ...(splitUpgrade ? { move_scope: "none" } : {}) }) : null;
    const circleCategory = await api("/api/collections/circle_categories/records", admin, { circle: circle.id, name: "Other", color: "#654321", active: true, sort_order: 0 });
    const shared = await api("/api/collections/circle_expenses/records", admin, { ...fields, category: relations ? circleCategory.id : "Other", user: undefined, title: "Existing Circle schedule", circle: circle.id, paid_by: payer.id, created_by: payer.id, version: 4, split_mode: "exact", shares: [{ member: payer.id, amount: 250 }, { member: former.id, amount: 400 }] });
    const sharedIncome = splitUpgrade ? await api("/api/collections/circle_expenses/records", admin, {
        ...fields, category: circleCategory.id, user: undefined, kind: "income", title: "Existing Circle income",
        circle: circle.id, paid_by: payer.id, created_by: payer.id, version: 3, split_mode: "exact",
        shares: [{ member: payer.id, amount: 650 }],
    }) : null;
    if (splitUpgrade) {
        const [mauve] = JSON.parse(await readFile("pocketbase/pb_hooks/theme-presets.json", "utf8"));
        prefs = await api(`/api/collections/preferences/records/${prefs.id}`, admin, { default_expense_category: category.id, default_income_category: category.id, payment_methods: [], shortcut_payment_methods: [], theme: { preset: "mauve", colors: mauve.colors } }, "PATCH");
    }

    const backfill = cutoff === "1793401200_category_relations_and_indexes.js";
    const historical = backfill ? await api("/api/collections/expenses/records", admin, { ...fields, merchant: "Historical category", category: "Old personal label" }) : null;
    const historicalShared = backfill ? await api("/api/collections/circle_expenses/records", admin, { ...fields, user: undefined, title: "Historical Circle category", category: "Old Circle label", circle: circle.id, paid_by: payer.id, created_by: payer.id, version: 1, split_mode: "exact", shares: [{ member: payer.id, amount: 250 }, { member: former.id, amount: 400 }] }) : null;
    const historicalBudget = backfill ? await api("/api/collections/budgets/records", admin, { user: user.id, category: "Old personal label", month: "2091-01", amount: 1000, currency: "SGD" }) : null;
    if (cutoff > "1793397600_circle_personal_moves.js" && cutoff <= "1793404800_remove_circle_personal_moves.js")
        await api("/api/collections/circle_personal_moves/records", admin, { user: user.id, circle: circle.id, expense: "deletedsource01", personal: active.id, version: 1, requested_category: "", snapshot: { receipt: { items: [] }, shares: [{ member: payer.id, amount: 650 }] } });
    await stop();
    const upgrade = spawnSync(binary, ["migrate", "up", ...newFlags], { encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
    await start(newFlags);
    assert.equal((await api("/api/expenditure/status")).version, 45);
    assert.equal((await fetch(base + "/api/collections/circle_personal_moves", { headers: { Authorization: admin } })).status, 404);
    const upgradedPreferences = await api(`/api/collections/preferences/records/${prefs.id}`, admin);
    for (const key of Object.keys(prefs).filter((key) => !splitUpgrade || key !== "default_income_category")) assert.deepEqual(upgradedPreferences[key], key === "default_tab" && prefs[key] === "API keys" ? "Settings" : prefs[key], `preferences.${key}`);
    assert.equal(upgradedPreferences.include_circle_in_budgets, prefs.include_circle_in_budgets ?? true);
    assert.equal(upgradedPreferences.default_api_circle, "");
    const schema = await api("/api/collections/preferences", admin);
    assert.ok(!schema.fields.find((field) => field.name === "default_tab").values.includes("API keys"));
    if (savedKey) {
        assert.deepEqual(await api(`/api/collections/api_keys/records/${savedKey.id}`, admin), savedKey);
        const response = await fetch(base + "/api/expenses/transactions", { headers: { "X-API-Key": savedSecret } });
        assert.equal(response.status, 200, await response.text());
    }

    assert.deepEqual((await api("/api/collections/users", admin)).oauth2, identity.oauth2);
    for (const [collection, records] of [["expenses", [active, paused, income, weekly, yearly, apiExpense, ...(historical ? [historical] : [])]], ["circle_expenses", [shared, ...(sharedIncome ? [sharedIncome] : []), ...(historicalShared ? [historicalShared] : [])]]]) {
        for (const original of records) {
            const upgraded = await api(`/api/collections/${collection}/records/${original.id}`, admin);
            for (const key of Object.keys(original)) {
                if (key === "category") {
                    assert.equal(upgraded.expand.category.kind, original.kind);
                    if (original.kind === "income") {
                        assert.notEqual(upgraded.category, original.category);
                        assert.equal(upgraded.expand.category.name, "Other");
                        if (splitUpgrade && collection === "expenses") assert.equal(upgradedPreferences.default_income_category, upgraded.category);
                    } else {
                        assert.equal(relations ? upgraded.category : upgraded.expand.category.name, original.category);
                    }
                }
                else if (["idempotency_key", "idempotency_data"].includes(key)) assert.equal(upgraded[key], undefined);
                else assert.deepEqual(upgraded[key], original[key], `${collection}.${key}`);
            }

            assert.equal(upgraded.recurrence_interval, original.recurrence_interval ?? (original.recurrence ? 1 : 0));
            assert.equal(upgraded.recurrence_day, original.recurrence_day || 0);
            assert.deepEqual(upgraded.recurrence_weekdays, []);
            assert.equal(upgraded.recurrence_month, 0);
        }
    }

    if (backfill) {
        const personal = await api(`/api/collections/expenses/records/${historical.id}`, admin);
        const budget = await api(`/api/collections/budgets/records/${historicalBudget.id}`, admin);
        const archived = await api(`/api/collections/categories/records/${personal.category}`, admin);
        assert.equal(archived.name, "Old personal label");
        assert.equal(archived.active, false);
        assert.equal(budget.category, personal.category);
        assert.equal(budget.created, historicalBudget.created);
        assert.equal(budget.updated, historicalBudget.updated);
        assert.equal(budget.amount, historicalBudget.amount);
    }

    const auth = await api("/api/collections/users/auth-with-password", null, { identity: user.email, password });
    const credentials = await api("/api/expenditure/keys", auth.token, { name: "Upgraded retries", scopes: ["expenses:write"], expires_at: "" });
    const retryResponse = await fetch(base + "/api/expenses/transactions", { method: "POST", headers: { "X-API-Key": credentials.key, "Idempotency-Key": "upgrade-retry", "Content-Type": "application/json" }, body: JSON.stringify(retryInput) });
    const retry = await retryResponse.json();
    assert.equal(retryResponse.status, 200, JSON.stringify(retry));
    assert.equal(retry.id, apiExpense.id);
    assert.equal(retry.replay, true);
    assert.equal(Date.parse(retry.idempotency_expires_at), Date.parse(apiExpense.created.replace(" ", "T")) + 24 * 3600000);
    for (const original of [payer, former]) {
        const upgraded = await api(`/api/collections/circle_members/records/${original.id}`, admin);
        for (const key of Object.keys(original)) assert.deepEqual(upgraded[key], original[key], `membership.${key}`);
        assert.equal(upgraded.can_add, true);
        assert.equal(upgraded.is_admin, false);
        assert.equal(upgraded.move_scope, "payer");
        assert.equal(upgraded.edit_scope, "own");
        assert.equal(upgraded.delete_scope, "own");
        assert.equal(upgraded.version, 1);
    }

    if (restricted) {
        const upgraded = await api(`/api/collections/circle_members/records/${restricted.id}`, admin);
        for (const key of Object.keys(restricted)) assert.deepEqual(upgraded[key], restricted[key], `restricted.${key}`);
        assert.equal(upgraded.move_scope, "none");
    }

    const detail = await api(`/api/expenditure/circles/${circle.id}`, auth.token);
    assert.equal(detail.balances.find((row) => row.member === payer.id).net, backfill ? 800 : 400);
    assert.equal(detail.balances.find((row) => row.member === former.id).net, backfill ? -800 : -400);
    assert.equal(detail.recurring[0].recurrence_next, shared.recurrence_next);
    await api(`/api/collections/preferences/records/${prefs.id}`, auth.token, { timezone: "Asia/Singapore", include_circle_in_budgets: false }, "PATCH");
    const edited = await api(`/api/collections/expenses/records/${active.id}`, auth.token, { notes: "Changed note" }, "PATCH");
    assert.equal(edited.recurrence_next, active.recurrence_next);
    assert.equal(edited.recurrence_timezone, "America/New_York");
    assert.equal(edited.recurrence_anchor, active.recurrence_anchor);
    await stop();
    const repeat = spawnSync(binary, ["migrate", "up", ...newFlags], { encoding: "utf8" });
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    await start(newFlags);
    assert.equal((await api(`/api/collections/preferences/records/${prefs.id}`, auth.token)).include_circle_in_budgets, false);
    assert.equal((await api(`/api/collections/expenses/records/${paused.id}`, auth.token)).recurrence_error, paused.recurrence_error);
});
