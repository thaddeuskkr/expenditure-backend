import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

test(
    "upgrade preserves existing amounts, categories, budgets, preferences and transactions from the retired API",
    { timeout: 30000 },
    async (t) => {
        const binary = process.env.POCKETBASE_BINARY;
        assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase executable.");
        const directory = await mkdtemp(join(tmpdir(), "expenditure-upgrade-"));
        const oldMigrations = join(directory, "old-migrations"),
            oldHooks = join(directory, "old-hooks"),
            data = join(directory, "data");
        await mkdir(oldMigrations);
        await mkdir(oldHooks);
        await copyFile(
            resolve("pocketbase/pb_migrations/1793026800_expenditure.js"),
            join(oldMigrations, "1793026800_expenditure.js"),
        );
        const listener = createServer();
        await new Promise((done) => listener.listen(0, "127.0.0.1", done));
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const base = `http://127.0.0.1:${port}`;
        const oldFlags = [
            `--dir=${data}`,
            `--migrationsDir=${oldMigrations}`,
            `--hooksDir=${oldHooks}`,
        ];
        const newFlags = [
            `--dir=${data}`,
            `--migrationsDir=${resolve("pocketbase/pb_migrations")}`,
            `--hooksDir=${resolve("pocketbase/pb_hooks")}`,
        ];
        const password = randomBytes(24).toString("hex");
        const setup = spawnSync(
            binary,
            ["superuser", "upsert", "test@example.com", password, ...oldFlags],
            { encoding: "utf8" },
        );
        assert.equal(setup.status, 0, setup.stderr);
        let child;
        async function stop() {
            if (child && child.exitCode === null && child.signalCode === null) {
                const exited = new Promise((done) => child.once("exit", done));
                child.kill("SIGTERM");
                await exited;
            }
        }

        t.after(async () => {
            await stop();
            await rm(directory, { recursive: true, force: true });
        });
        async function start(flags) {
            child = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            let logs = "";
            child.stdout.on("data", (c) => {
                logs += c;
            });
            child.stderr.on("data", (c) => {
                logs += c;
            });
            for (let i = 0; i < 100; i++) {
                try {
                    if ((await fetch(base + "/api/health")).ok) return;
                } catch {}

                if (child.exitCode !== null) assert.fail(logs);
                await new Promise((done) => setTimeout(done, 30));
            }

            assert.fail(logs);
        }

        await start(oldFlags);
        async function request(path, token, body, method = body ? "POST" : "GET") {
            if (method === "GET" && /^\/api\/collections\/(expenses|budgets|circle_expenses)\/records/.test(path)) path += (path.includes("?") ? "&" : "?") + "expand=category";
            const response = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { Authorization: token } : {}),
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            const result = text ? JSON.parse(text) : null;
            assert.ok(response.ok, JSON.stringify(result));
            return result;
        }

        const admin = (
            await request("/api/collections/_superusers/auth-with-password", null, {
                identity: "test@example.com",
                password,
            })
        ).token;
        await request("/api/collections/users", admin, {
            oauth2: {
                enabled: true,
                providers: [{
                    name: "oidc",
                    displayName: "Existing identity provider",
                    clientId: "upgrade-test",
                    clientSecret: "disposable-test-secret",
                    authURL: "https://identity.example.com/authorize",
                    tokenURL: "https://identity.example.com/token",
                    userInfoURL: "https://identity.example.com/userinfo",
                }],
            },
        }, "PATCH");
        const identityBefore = await request("/api/collections/users", admin);
        const user = await request("/api/collections/users/records", admin, {
            email: "upgrade@example.com",
            password,
            passwordConfirm: password,
        });
        const expense = await request("/api/collections/expenses/records", admin, {
            user: user.id,
            merchant: "Existing coffee",
            currency: "SGD",
            category: "Food & drinks",
            amount_cents: 850,
            card: "Stored Visa",
            occurred_at: "2026-10-26T00:00:00Z",
            source: "api",
            idempotency_key: "preserved-idempotency",
        });
        await request("/api/collections/budgets/records", admin, {
            user: user.id,
            month: "2026-10",
            currency: "SGD",
            category: "Overall",
            amount_cents: 100000,
        });
        const budget = await request("/api/collections/budgets/records", admin, {
            user: user.id,
            month: "2026-10",
            currency: "SGD",
            category: "Food & drinks",
            amount_cents: 20000,
        });
        const prefs = await request("/api/collections/preferences/records", admin, {
            user: user.id,
            currency: "SGD",
            timezone: "Asia/Singapore",
        });
        await request("/api/collections/api_keys/records", admin, {
            user: user.id,
            name: "Existing key",
            key_hash: "existing-secret-hash",
            key_prefix: "exp_existing",
            scopes: ["expenses:read"],
        });
        await stop();
        // Stage the previous schema with real category rows before adding order.
        await copyFile(resolve("pocketbase/pb_hooks/currencies.json"), join(oldHooks, "currencies.json"));
        for (const file of ["1793100000_categories_currencies_rates.js", "1793103600_circles.js"]) {
            await copyFile(resolve("pocketbase/pb_migrations", file), join(oldMigrations, file));
        }

        const previousSchema = spawnSync(binary, ["migrate", "up", ...oldFlags], { encoding: "utf8" });
        assert.equal(previousSchema.status, 0, previousSchema.stderr + previousSchema.stdout);
        await start(oldFlags);
        const secondUser = await request("/api/collections/users/records", admin, {
            email: "second-upgrade@example.com", password, passwordConfirm: password,
        });
        for (const [owner, names] of [[user.id, ["Other", "Food & drinks", "Groceries"]], [secondUser.id, ["Second Z", "Second A"]]]) {
            for (const [index, name] of names.entries()) {
                await request("/api/collections/categories/records", admin, {
                    user: owner, name, color: "#aabbcc", active: index !== 0,
                });
            }
        }

        async function categoryRows(owner, sort) {
            return (await request(`/api/collections/categories/records?perPage=100&sort=${sort}&filter=${encodeURIComponent(`user = '${owner}'`)}`, admin)).items;
        }

        const previousCategories = await categoryRows(user.id, "created,name,id");
        const secondPrevious = await categoryRows(secondUser.id, "created,name,id");
        const circle = await request("/api/collections/circles/records", admin, {
            owner: user.id, name: "Existing circle", icon: "plane", currency: "SGD", version: 1,
        });
        const members = [];
        for (const [owner, name] of [[user.id, "Owner"], [secondUser.id, "Member"]]) {
            members.push(await request("/api/collections/circle_members/records", admin, {
                circle: circle.id, user: owner, name, active: true,
            }));
        }

        const shared = [];
        for (const [currency, amount, split_mode, shares] of [
            ["SGD", 650, "even", [{ member: members[0].id, amount_minor: 325 }, { member: members[1].id, amount_minor: 325 }]],
            ["JPY", 1000, "percentage", [{ member: members[0].id, amount_minor: 300, percentage_bp: 3000 }, { member: members[1].id, amount_minor: 700, percentage_bp: 7000 }]],
            ["KWD", 1234, "exact", [{ member: members[1].id, amount_minor: 1234 }]],
        ]) {
            shared.push(await request("/api/collections/circle_expenses/records", admin, {
                circle: circle.id, paid_by: members[0].id, created_by: members[0].id,
                title: "Existing shared expense", currency, amount_minor: amount,
                split_mode, shares, payment_method: "Stored Mastercard", notes: "Keep this note",
                occurred_at: "2026-10-27T00:00:00Z", version: 1,
            }));
        }

        const cachedRates = { quotes: { EUR: 1, SGD: 1.5, JPY: 150 }, dates: { SGD: "2026-10-27", JPY: "2026-10-27" } };
        await request("/api/collections/exchange_rates/records/fxlatest0000000", admin, {
            data: cachedRates, fetched_at: "2026-10-27T00:00:00Z", attempted_at: "2026-10-27T00:00:00Z",
        }, "PATCH");
        const preferencesBefore = await request(`/api/collections/preferences/records/${prefs.id}`, admin);
        assert.deepEqual(preferencesBefore.currencies, []);
        const settlement = await request("/api/collections/circle_settlements/records", admin, {
            circle: circle.id, from_member: members[1].id, to_member: members[0].id,
            created_by: members[0].id, currency: "SGD", amount_minor: 100,
            notes: "Existing repayment", occurred_at: "2026-10-27T00:00:00Z", version: 1,
        });
        await stop();
        const upgrade = spawnSync(binary, ["migrate", "up", ...newFlags], {
            encoding: "utf8",
        });
        assert.equal(upgrade.status, 0, upgrade.stderr + upgrade.stdout);
        await start(newFlags);
        const rates = await request("/api/collections/exchange_rates/records/fxlatest0000000", admin);
        assert.deepEqual(rates.quotes, cachedRates.quotes);
        assert.deepEqual(rates.dates, cachedRates.dates);
        assert.equal(rates.data, undefined);
        assert.equal(Date.parse(rates.fetched_at), Date.parse("2026-10-27T00:00:00Z"));
        const storedPreferences = await request(`/api/collections/preferences/records/${prefs.id}`, admin);
        assert.deepEqual(storedPreferences.currencies, ["SGD", "USD", "EUR", "GBP", "AUD", "MYR"]);
        assert.deepEqual(storedPreferences.payment_methods, []);
        assert.deepEqual(storedPreferences.theme, { preset: "mauve", colors: { background: "#1C181D", surface: "#2A232C", raised: "#403343", accent: "#D6B4D5", text: "#F3EDF3", muted: "#C1B1C1" } });
        assert.equal(storedPreferences.updated, preferencesBefore.updated);
        const rateSchema = await request("/api/collections/exchange_rates", admin);
        assert.ok(rateSchema.fields.some((field) => field.name === "quotes"));
        assert.ok(rateSchema.fields.some((field) => field.name === "dates"));
        assert.ok(!rateSchema.fields.some((field) => field.name === "data"));
        const identityAfter = await request("/api/collections/users", admin);
        assert.deepEqual(identityAfter.oauth2, identityBefore.oauth2);
        assert.deepEqual(identityAfter.passwordAuth, identityBefore.passwordAuth);
        const after = await request(
            `/api/collections/expenses/records/${expense.id}`,
            admin,
        );
        assert.equal(after.amount, 850);
        assert.equal(after.kind, "expense");
        assert.equal(after.moved_to, "");
        assert.equal(after.moved_circle, "");
        assert.equal(after.recurrence, "");
        assert.equal(storedPreferences.default_tab, "Overview");
        assert.equal(storedPreferences.time_format, "24h");
        assert.equal(storedPreferences.show_circle_transactions, false);
        assert.equal(storedPreferences.include_circle_in_budgets, true);
        assert.equal(storedPreferences.default_entry_currency, "");
        assert.equal(storedPreferences.default_expense_category, "");
        assert.equal(storedPreferences.default_income_category, "");
        assert.equal(storedPreferences.timezone, preferencesBefore.timezone);
        assert.equal(after.payment_method, "Stored Visa");
        assert.equal(after.amount_cents, undefined);
        assert.equal(after.card, undefined);
        assert.equal(after.expand.category.name, "Food & drinks");
        assert.equal(after.currency, "SGD");
        assert.equal(after.source, "shortcut");
        const preserved = await request(
            `/api/collections/budgets/records/${budget.id}`,
            admin,
        );
        assert.equal(preserved.expand.category.name, "Food & drinks");
        assert.equal(preserved.amount, 20000);
        assert.equal(preserved.amount_cents, undefined);
        assert.equal(
            (await request("/api/collections/budgets/records", admin)).totalItems,
            2,
        );
        assert.equal(
            (await request(`/api/collections/preferences/records/${prefs.id}`, admin))
                .timezone,
            "Asia/Singapore",
        );
        const auth = await request(
            "/api/collections/users/auth-with-password",
            null,
            { identity: "upgrade@example.com", password },
        );
        const config = await request("/api/expenditure/config", auth.token);
        for (const name of ["expenses", "budgets", "circle_expenses", "circle_settlements"]) {
            const collection = await request(`/api/collections/${name}`, admin);
            const fields = collection.fields.map((field) => field.name);
            assert.ok(fields.includes("amount"));
            assert.ok(!fields.includes("amount_cents") && !fields.includes("amount_minor"));
            if (name === "expenses") {
                assert.ok(fields.includes("payment_method"));
                assert.ok(!fields.includes("card"));
            }
        }

        const expenseSchema = await request("/api/collections/expenses", admin);
        assert.ok(!expenseSchema.fields.some((field) => ["idempotency_key", "idempotency_data"].includes(field.name)));
        const detail = await request(`/api/expenditure/circles/${circle.id}`, auth.token);
        assert.equal(detail.categories.filter((row) => row.kind === "expense").length, 8);
        assert.deepEqual(detail.categories.filter((row) => row.kind === "expense").map((row) => row.sort_order), [0, 1, 2, 3, 4, 5, 6, 7]);
        for (const original of shared) {
            const migrated = detail.expenses.items.find((item) => item.id === original.id);
            assert.equal(migrated.amount, original.amount_minor);
            assert.equal(migrated.expand.category.name, "Other");
            assert.equal(migrated.source, "manual");
            assert.equal(migrated.amount_minor, undefined);
            assert.equal(migrated.receipt, null);
            assert.deepEqual(migrated.shares, original.shares.map(({ amount_minor, ...share }) => ({ ...share, amount: amount_minor })));
            assert.equal(migrated.payment_method, original.payment_method);
            assert.equal(migrated.notes, original.notes);
            const stored = await request(`/api/collections/circle_expenses/records/${original.id}`, admin);
            assert.equal(stored.created, original.created);
            assert.equal(stored.updated, original.updated);
        }

        assert.equal(detail.settlements.items[0].id, settlement.id);
        assert.equal(detail.settlements.items[0].amount, 100);
        assert.equal(detail.settlements.items[0].amount_minor, undefined);
        for (const [currency, net] of [["SGD", 225], ["JPY", 700], ["KWD", 1234]]) {
            assert.equal(detail.balances.find((row) => row.member === members[0].id && row.currency === currency).net, net);
            assert.equal(detail.balances.find((row) => row.member === members[1].id && row.currency === currency).net, -net);
        }

        assert.deepEqual(config.categories.filter((row) => row.kind === "expense").map((category) => category.id), previousCategories.map((category) => category.id));
        assert.deepEqual(config.categories.filter((row) => row.kind === "expense").map((category) => category.sort_order), [0, 1, 2]);
        assert.deepEqual(config.categories.filter((row) => row.kind === "expense").map((category) => category.active), previousCategories.map((category) => category.active));
        const secondAfter = (await categoryRows(secondUser.id, "sort_order")).filter((row) => row.kind === "expense");
        assert.deepEqual(secondAfter.map((category) => category.id), secondPrevious.map((category) => category.id));
        assert.deepEqual(secondAfter.map((category) => category.sort_order), [0, 1]);
        assert.ok(config.categories.some((c) => c.name === "Food & drinks"));
        assert.equal(config.preferences.currency, "SGD");
        const category = detail.categories.find((row) => row.name === "Other" && row.kind === "expense");
        const shortcutExpense = await request(`/api/expenditure/circles/${circle.id}/expenses`, auth.token, {
            title: "Added after upgrade", amount: 501, currency: "SGD", occurred_at: "2026-10-27T04:00:00Z",
            category: category.id, paid_by: members[0].id, split_mode: "percentage",
            shares: [{ member: members[0].id, percentage_bp: 10000 }],
        });
        assert.equal(shortcutExpense.paid_by, members[0].id);
        assert.deepEqual(shortcutExpense.shares, [{ member: members[0].id, amount: 501, percentage_bp: 10000 }]);
        const updatedDetail = await request(`/api/expenditure/circles/${circle.id}`, auth.token);
        assert.deepEqual(updatedDetail.balances, detail.balances);
        for (const original of shared) {
            assert.deepEqual(updatedDetail.expenses.items.find((item) => item.id === original.id), detail.expenses.items.find((item) => item.id === original.id));
        }

        const editedRepayment = await request(`/api/expenditure/circles/${circle.id}/settlements/${settlement.id}`, auth.token, {
            from_member: members[1].id, to_member: members[0].id, currency: "SGD", amount: 50,
            notes: "Corrected after upgrade", version: settlement.version,
        }, "PATCH");
        assert.equal(editedRepayment.id, settlement.id);
        assert.equal(editedRepayment.created, settlement.created);
        assert.equal(editedRepayment.created_by, settlement.created_by);
        assert.equal(editedRepayment.occurred_at, settlement.occurred_at);
        assert.equal(editedRepayment.version, settlement.version + 1);
        const afterRepaymentEdit = await request(`/api/expenditure/circles/${circle.id}`, auth.token);
        assert.equal(afterRepaymentEdit.balances.find((row) => row.member === members[0].id && row.currency === "SGD").net, 275);
        assert.equal(afterRepaymentEdit.balances.find((row) => row.member === members[1].id && row.currency === "SGD").net, -275);
        assert.ok(afterRepaymentEdit.suggestions.some((row) => row.currency === "SGD" && row.amount === 275));

        const summaryRange = new URLSearchParams({ from: "2026-09-30T16:00:00Z", to: "2026-10-31T16:00:00Z", previous: "2026-08-31T16:00:00Z", currency: "SGD" });
        const summary = await request(`/api/expenditure/overview?${summaryRange}`, auth.token);
        assert.equal(summary.total, 850 + 325 + 501);
        assert.equal(summary.count, 3);
        assert.equal(summary.categories.find((row) => row.category_name === "Food & drinks").total, 850);
        assert.equal(summary.categories.find((row) => row.category_name === "Other").total, 325 + 501);
        const memberSchema = await request("/api/collections/circle_members", admin);
        assert.ok(memberSchema.indexes.some((index) => index.includes("idx_circle_members_user_circle")));

        // Re-running migration commands must not duplicate or reset user data.
        await request(`/api/collections/preferences/records/${prefs.id}`, auth.token, { time_format: "12h", timezone: "Asia/Katmandu", show_circle_transactions: true }, "PATCH");
        await stop();
        const repeat = spawnSync(binary, ["migrate", "up", ...newFlags], {
            encoding: "utf8",
        });
        assert.equal(repeat.status, 0, repeat.stderr);
        await start(newFlags);
        assert.equal((await request(`/api/collections/preferences/records/${prefs.id}`, auth.token)).time_format, "12h");
        assert.equal((await request(`/api/collections/preferences/records/${prefs.id}`, auth.token)).show_circle_transactions, true);
        assert.equal((await request(`/api/collections/preferences/records/${prefs.id}`, auth.token)).timezone, "Asia/Katmandu");
    },
);
