import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";

test("upgrade removes retired credentials and routes while preserving passwords, OIDC, API keys and account data", { timeout: 30000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to PocketBase 0.40.6.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-credential-removal-"));
    const migrations = join(directory, "old-migrations");
    const data = join(directory, "data");
    const oldHooks = join(directory, "old-hooks");
    await mkdir(oldHooks);
    for (const name of ["currencies.json", "timezones.json", "theme-core.cjs", "theme-presets.json"])
        await copyFile(resolve("pocketbase/pb_hooks", name), join(oldHooks, name));
    await mkdir(migrations);
    for (const name of await readdir("pocketbase/pb_migrations")) {
        if (name <= "1793750400_login_keys.js") await copyFile(resolve("pocketbase/pb_migrations", name), join(migrations, name));
    }

    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const base = `http://127.0.0.1:${port}`;
    const flags = [`--dir=${data}`, `--hooksDir=${resolve("pocketbase/pb_hooks")}`];
    const oldFlags = [`--dir=${data}`, `--hooksDir=${oldHooks}`];
    const password = randomBytes(24).toString("hex");
    const setup = spawnSync(binary, ["superuser", "upsert", "test@example.com", password, ...oldFlags, `--migrationsDir=${migrations}`], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    let child;
    let logs = "";
    async function stop() {
        if (child && child.exitCode === null && child.signalCode === null) {
            const done = new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGTERM");
            await done;
        }
    }

    t.after(async () => {
        await stop();
        await rm(directory, { force: true, recursive: true });
    });
    async function start(migrationsDir, serverFlags = flags) {
        child = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...serverFlags, `--migrationsDir=${migrationsDir}`], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => {
            logs += chunk;
        });
        child.stderr.on("data", (chunk) => {
            logs += chunk;
        });
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                if ((await fetch(base + "/api/health")).ok) return;
            } catch {}

            if (child.exitCode !== null) assert.fail(logs);
            await new Promise((done) => setTimeout(done, 25));
        }

        assert.fail(logs);
    }

    async function api(path, token, body, method = body ? "POST" : "GET", expected = 200) {
        const response = await fetch(base + path, {
            method, headers: { ...(token ? { Authorization: token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        const result = text ? JSON.parse(text) : null;
        assert.equal(response.status, expected, `${path}: ${text}\n${response.status >= 500 ? logs : ""}`);
        return result;
    }

    await start(migrations, oldFlags);
    const admin = (await api("/api/collections/_superusers/auth-with-password", null, { identity: "test@example.com", password })).token;
    const user = await api("/api/collections/users/records", admin, { email: "review@example.com", name: "Reviewer", password, passwordConfirm: password, verified: true });
    const create = (table, fields) => api(`/api/collections/${table}/records`, admin, fields);
    const preferencesBefore = await create("preferences", { user: user.id, currency: "SGD", currencies: ["SGD"], timezone: "Asia/Singapore", default_tab: "Overview", time_format: "24h", include_circle_in_budgets: true });
    const category = await create("categories", { user: user.id, name: "Other", active: true, color: "#a59aaa" });
    await api("/api/collections/users", admin, { oauth2: { enabled: true, providers: [{ name: "oidc", clientId: "local-client", clientSecret: "local-secret", authURL: "https://issuer.invalid/authorize", tokenURL: "https://issuer.invalid/token", userInfoURL: "https://issuer.invalid/userinfo" }] } }, "PATCH");
    const schemaBefore = await api("/api/collections/users", admin);
    const key = "exp_" + randomBytes(24).toString("hex");
    const apiKeyBefore = await create("api_keys", { user: user.id, name: "Existing automation", key_hash: createHash("sha256").update(key).digest("hex"), key_prefix: key.slice(0, 12), scopes: ["expenses:read"] });
    const expense = await create("expenses", { user: user.id, kind: "expense", source: "manual", merchant: "Existing purchase", amount: 1250, currency: "SGD", category: category.id, occurred_at: "2026-11-04T00:00:00Z", payment_method: "Visa", notes: "Preserve me" });
    const circle = await create("circles", { owner: user.id, name: "Preserved ledger", currency: "SGD", icon: "home", version: 1 });
    const member = await create("circle_members", { circle: circle.id, user: user.id, name: user.name, active: true, can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer", version: 1 });
    const sharedCategory = await create("circle_categories", { circle: circle.id, name: "Other", color: "#a59aaa", active: true });
    const sharedInput = { circle: circle.id, kind: "expense", title: "Existing Circle entry", amount: 1000, currency: "SGD", category: sharedCategory.id, paid_by: member.id, created_by: member.id, split_mode: "percentage", shares: [{ member: member.id, percentage_bp: 10000, amount: 1000 }], occurred_at: "2026-11-04T00:00:00Z", version: 1 };
    const shared = await create("circle_expenses", { ...sharedInput, source: "manual" });
    const oldImport = await create("circle_expenses", { ...sharedInput, title: "Existing imported Circle entry", source: "api" });
    for (const state of [{}, { revoked_at: "2026-11-01T00:00:00Z" }, { expires_at: "2026-11-01T00:00:00Z" }]) {
        const secret = "exp_login_" + randomBytes(24).toString("hex");
        await api("/api/collections/login_keys/records", admin, { user: user.id, name: "Retired credential", key_hash: createHash("sha256").update(secret).digest("hex"), key_prefix: secret.slice(0, 18), ...state });
    }

    assert.equal((await api("/api/collections/login_keys/records", admin)).totalItems, 3);
    await stop();
    const migrate = spawnSync(binary, ["migrate", "up", ...flags, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`], { encoding: "utf8" });
    assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
    await start(resolve("pocketbase/pb_migrations"));
    assert.equal((await api("/api/expenditure/status")).version, 45);
    const auth = await api("/api/collections/users/auth-with-password", null, { identity: user.email, password });
    await api("/api/collections/login_keys", admin, undefined, "GET", 404);
    await api("/api/collections/login_keys/records", admin, undefined, "GET", 404);
    for (const [path, method, body] of [
        ["/api/expenditure/login-keys", "GET"],
        ["/api/expenditure/login-keys", "POST", { name: "Should not exist", expires_at: "" }],
        ["/api/expenditure/login-keys/missing", "DELETE"],
        ["/api/expenditure/auth-with-login-key", "POST", { identity: user.email, key: "retired" }],
    ]) await api(path, auth.token, body, method, 404);
    const ledger = await api(`/api/expenditure/circles/${circle.id}`, auth.token);
    for (const before of [shared, oldImport]) {
        const after = ledger.expenses.items.find((entry) => entry.id === before.id);
        for (const [field, value] of Object.entries(before)) assert.deepEqual(after[field], value);
    }
    for (const name of ["expenses", "circle_expenses"]) {
        const schema = await api(`/api/collections/${name}`, admin);
        assert.deepEqual(schema.fields.find((field) => field.name === "source").values, ["manual", "api", "shortcut"]);
    }

    const schemaAfter = await api("/api/collections/users", admin);
    for (const field of ["oauth2", "passwordAuth", "authRule", "authToken"]) assert.deepEqual(schemaAfter[field], schemaBefore[field]);
    const passwordAuth = await api("/api/collections/users/auth-with-password", null, { identity: user.email, password });
    assert.equal(passwordAuth.record.id, user.id);
    const config = await api("/api/expenditure/config", passwordAuth.token);
    assert.deepEqual(config.preferences, { ...preferencesBefore, shortcut_payment_methods: [], strip_wallet_merchant_location: false });
    assert.deepEqual(config.categories.find((row) => row.kind === "expense"), { ...category, kind: "expense" });
    assert.deepEqual(await api(`/api/collections/expenses/records/${expense.id}`, passwordAuth.token), expense);
    assert.deepEqual(await api(`/api/collections/api_keys/records/${apiKeyBefore.id}`, admin), apiKeyBefore);
    const response = await fetch(base + "/api/expenses/transactions", { headers: { "X-API-Key": key } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].id, expense.id);
    const databaseCheck = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert not c.execute(\"SELECT name FROM sqlite_master WHERE name LIKE '%login_keys%'\").fetchall()", join(data, "data.db")], { encoding: "utf8" });
    assert.equal(databaseCheck.status, 0, databaseCheck.stderr);
    await stop();
    const repeat = spawnSync(binary, ["migrate", "up", ...flags, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`], { encoding: "utf8" });
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
});
