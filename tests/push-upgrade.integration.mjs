import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { cp, copyFile, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

for (const cutoff of ["1794096000_circle_push.js", "1794442800_separate_transaction_categories.js"]) test(`notification upgrade from ${cutoff} preserves devices and supported deliveries`, { timeout: 30000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-push-upgrade-"));
    const hooks = join(directory, "old-hooks"), migrations = join(directory, "old-migrations"), data = join(directory, "data");
    await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
    for (const file of await readdir(hooks)) if (file.endsWith(".pb.js")) await rm(join(hooks, file));
    await mkdir(migrations);
    for (const file of await readdir(resolve("pocketbase/pb_migrations"))) {
        if (file.endsWith(".js") && file <= cutoff)
            await copyFile(resolve("pocketbase/pb_migrations", file), join(migrations, file));
    }

    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const base = `http://127.0.0.1:${port}`;
    const oldFlags = [`--dir=${data}`, `--hooksDir=${hooks}`, `--migrationsDir=${migrations}`];
    const newFlags = [`--dir=${data}`, `--hooksDir=${resolve("pocketbase/pb_hooks")}`, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`];
    const password = randomBytes(24).toString("hex");
    const setup = spawnSync(binary, ["superuser", "upsert", "upgrade@example.com", password, ...oldFlags], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    let child, logs = "";
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
        child = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags], { stdio: ["ignore", "pipe", "pipe"] });
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

            await new Promise((done) => setTimeout(done, 25));
        }

        assert.fail(logs);
    }

    async function api(path, { token, body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result) + logs.slice(-1000));
        return result;
    }

    await start(oldFlags);
    const admin = (await api("/api/collections/_superusers/auth-with-password", { body: { identity: "upgrade@example.com", password } })).token;
    const create = (collection, body) => api(`/api/collections/${collection}/records`, { token: admin, body });
    const from45 = cutoff === "1794442800_separate_transaction_categories.js";
    const owner = await create("users", { email: "owner@example.com", password, passwordConfirm: password, verified: true });
    const recipient = await create("users", { email: "recipient@example.com", password, passwordConfirm: password, verified: true });
    const circle = await create("circles", { owner: owner.id, name: "Existing ledger", currency: "SGD", icon: "plane", version: 1 });
    const memberBody = { circle: circle.id, active: true, version: 1, can_add: true, is_admin: false, edit_scope: "own", delete_scope: "own", move_scope: "payer" };
    const author = await create("circle_members", { ...memberBody, user: owner.id, name: "Owner" });
    const member = await create("circle_members", { ...memberBody, user: recipient.id, name: "Recipient" });
    const category = await create("circle_categories", { circle: circle.id, name: "Other", color: "#d6b4d5", active: true, sort_order: 0, ...(from45 ? { kind: "expense" } : {}) });
    const expense = await create("circle_expenses", {
        circle: circle.id, paid_by: author.id, created_by: author.id, category: category.id, title: "Existing expense",
        amount: 1234, currency: "SGD", kind: "expense", source: "manual", version: 1, split_mode: "even",
        shares: [{ member: author.id, amount: 617 }, { member: member.id, amount: 617 }],
        occurred_at: "2026-11-08T00:00:00Z", recurrence_weekdays: [],
    });
    const device = await create("push_devices", {
        user: recipient.id, installation: "00000000-0000-4000-8000-000000000001", token: "ab".repeat(32), environment: "sandbox", server: base,
        ...(from45 ? { circle_expenses: true, circle_invitations: true, repayments: true, shortcut_expenses: true, api_expenses: true } : {}),
    });
    const delivery = await create("push_deliveries", {
        device: device.id, member: member.id, expense: expense.id, attempts: 2, next_attempt: "2030-01-01T00:00:00Z",
        payload: { type: "circle_expense", user: recipient.id, circle: circle.id, expense: expense.id, server: base },
    });
    let retiredDelivery;
    if (from45) {
        const personalCategory = await create("categories", { user: recipient.id, kind: "expense", name: "Other", color: "#a59aaa", active: true });
        const imported = await create("expenses", { user: recipient.id, kind: "expense", source: "api", merchant: "Imported expense",
            amount: 1234, currency: "SGD", category: personalCategory.id, occurred_at: expense.occurred_at });
        retiredDelivery = await create("push_deliveries", {
            device: device.id, personal_expense: imported.id, attempts: 0, next_attempt: "2030-01-01T00:00:00Z",
            payload: { type: "api_expense", user: recipient.id, expense: imported.id, server: base },
        });
    }
    await stop();
    const upgrade = spawnSync(binary, ["migrate", "up", ...newFlags], { encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
    await start(newFlags);
    const read = (collection, id) => api(`/api/collections/${collection}/records/${id}`, { token: admin });
    const { api_expenses: retired, ...remaining } = device;
    assert.deepEqual(await read("push_devices", device.id), { ...remaining, circle_expenses: true, circle_invitations: true, repayments: true, shortcut_expenses: from45 });
    if (retiredDelivery)
        await api(`/api/collections/push_deliveries/records/${retiredDelivery.id}`, { token: admin, expected: 404 });
    assert.deepEqual(await read("push_deliveries", delivery.id), { ...delivery, invitation: "", settlement: "", personal_expense: "" });
    for (const [collection, before] of [["circle_expenses", expense], ["circles", circle], ["circle_members", member], ["circle_members", author]])
        assert.deepEqual(await read(collection, before.id), before);
    const invitations = await api("/api/collections/push_deliveries/records?filter=invitation%20%21%3D%20%27%27", { token: admin });
    assert.equal(invitations.totalItems, 0, "Upgrading never backfills invitation alerts");
});
