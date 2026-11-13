import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { cp, copyFile, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import themes from "../pocketbase/pb_hooks/theme-core.cjs";

test("Mauve upgrade retires Sage and default green accents while preserving account choices and timestamps", { timeout: 30000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-mauve-upgrade-"));
    const hooks = join(directory, "old-hooks"), migrations = join(directory, "old-migrations"), data = join(directory, "data");
    await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
    for (const file of await readdir(hooks)) if (file.endsWith(".pb.js")) await rm(join(hooks, file));
    await mkdir(migrations);
    for (const file of await readdir(resolve("pocketbase/pb_migrations"))) {
        if (file.endsWith(".js") && file < "1793667600_mauve_brand_default.js")
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
    const sage = { preset: "sage", colors: { background: "#181B18", surface: "#20241F", raised: "#2B3029", accent: "#C2CBB0", text: "#EEEEE7", muted: "#9AA294" } };
    const mauve = { preset: "mauve", colors: themes.presets.find((item) => item.id === "mauve").colors };
    const midnight = { preset: "midnight", colors: themes.presets.find((item) => item.id === "midnight").colors };
    const custom = { preset: "custom", colors: { ...mauve.colors, accent: "#FFFFFF" } };
    const snapshots = [];
    let owner;
    for (const [index, theme] of [sage, midnight, custom].entries()) {
        const user = await api("/api/collections/users/records", { token: admin, body: { email: `theme${index}@example.com`, password, passwordConfirm: password, verified: true } });
        owner ??= user;
        const preference = await api("/api/collections/preferences/records", { token: admin, body: { user: user.id, currency: "SGD", currencies: ["SGD"], timezone: "Asia/Singapore", default_tab: "Overview", time_format: "24h", payment_methods: [], theme } });
        snapshots.push(preference);
    }

    const category = await api("/api/collections/categories/records", { token: admin, body: { user: owner.id, name: "Food & drinks", color: "#bfc9a4", active: true, sort_order: 0 } });
    const chosenCategory = await api("/api/collections/categories/records", { token: admin, body: { user: owner.id, name: "My category", color: "#123456", active: true, sort_order: 1 } });
    const circle = await api("/api/collections/circles/records", { token: admin, body: { owner: owner.id, name: "Existing Circle", icon: "plane", currency: "SGD", version: 1 } });
    const circleCategory = await api("/api/collections/circle_categories/records", { token: admin, body: { circle: circle.id, name: "Groceries", color: "#8dada0", active: true, sort_order: 0 } });
    await stop();
    const upgrade = spawnSync(binary, ["migrate", "up", ...newFlags], { encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
    await start(newFlags);
    for (const [index, before] of snapshots.entries()) {
        const after = await api(`/api/collections/preferences/records/${before.id}`, { token: admin });
        const { default_api_circle: retired, ...preferences } = before;
        assert.deepEqual(after, { ...preferences, theme: index === 0 ? mauve : before.theme, shortcut_payment_methods: [], strip_wallet_merchant_location: false });
    }

    for (const [collection, before, color] of [["categories", category, "#d6b4d5"], ["categories", chosenCategory, "#123456"], ["circle_categories", circleCategory, "#b5baff"]]) {
        assert.deepEqual(await api(`/api/collections/${collection}/records/${before.id}`, { token: admin }), { ...before, color, kind: "expense" });
    }

    await api(`/api/collections/preferences/records/${snapshots[0].id}`, { token: admin, method: "PATCH", body: { theme: sage }, expected: 400 });
    assert.deepEqual((await api(`/api/collections/preferences/records/${snapshots[0].id}`, { token: admin })).theme, mauve);
});
