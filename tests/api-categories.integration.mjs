import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("API-key category lookup follows workspace defaults and membership boundaries", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-api-categories-"));
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
    async function api(path, { token, key, body, headers = {}, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        const response = await fetch(base + path, {
            method,
            headers: { ...headers, ...(token ? { Authorization: token } : {}), ...(key ? { "X-API-Key": key } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const content = await response.text();
        const data = content ? JSON.parse(content) : null;
        assert.equal(response.status, expected, JSON.stringify({ path, data }) + (response.status >= 500 ? logs : ""));
        if (response.ok && path.startsWith("/api/expenses/") && path.endsWith("/categories"))
            assert.equal(response.headers.get("Cache-Control"), "no-store");
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

    const owner = await user("Owner"), member = await user("Member"), outsider = await user("Outsider");
    const root = "/api/expenditure/circles";
    const forKind = (rows, kind = "expense") => rows.filter((row) => row.kind === kind);
    const path = "/api/expenses/categories";
    const circle = await api(root, { token: owner.token, body: { name: "Shared", currency: "SGD" }, expected: 201 });
    const second = await api(root, { token: owner.token, body: { name: "Explicit", currency: "JPY" }, expected: 201 });
    const explicit = `/api/expenses/circles/${circle.id}/categories`;
    const secondPath = `/api/expenses/circles/${second.id}/categories`;
    const invite = await api(`${root}/${circle.id}/invitations`, { token: owner.token, body: { email: member.email }, expected: 201 });
    const membership = (await api(`/api/expenditure/circle-invitations/${invite.id}/accept`, { token: member.token, body: {} })).member;
    async function key(account, scopes = ["expenses:read"]) {
        return api("/api/expenditure/keys", { token: account.token, body: { name: "Categories", scopes, expires_at: "" }, expected: 201 });
    }

    const ownerKey = await key(owner), memberKey = await key(member), outsiderKey = await key(outsider), writeKey = await key(member, ["expenses:write"]);
    const config = (account) => api("/api/expenditure/config", { token: account.token });
    const ownerConfig = await config(owner), memberConfig = await config(member);
    const setDefault = (account, preferences, circle) => api(`/api/collections/preferences/records/${preferences.id}`, { token: account.token, method: "PATCH", body: { default_api_circle: circle } });
    const personal = await api("/api/expenditure/categories", { token: member.token, body: { name: "Personal only", color: "#123456" }, expected: 201 });
    const shared = await api(`${root}/${circle.id}/categories`, { token: owner.token, body: { name: "Circle only", color: "#654321" }, expected: 201 });
    const other = await api(`${root}/${second.id}/categories`, { token: owner.token, body: { name: "Explicit only", color: "#abcdef" }, expected: 201 });
    // Exceed the usual 30-row page size in both ledgers to catch truncation.
    for (let index = 0; index < 25; index++) {
        await api("/api/expenditure/categories", { token: member.token, body: { name: `Personal ${index}`, color: "#123456" }, expected: 201 });
        await api(`${root}/${circle.id}/categories`, { token: owner.token, body: { name: `Shared ${index}`, color: "#654321" }, expected: 201 });
    }

    await t.test("both routes require a valid read key and ignore unrelated sessions", async () => {
        for (const route of [path, explicit]) {
            await api(route, { expected: 401 });
            await api(route, { token: member.token, expected: 401 });
            await api(route, { key: "exp_invalid", expected: 401 });
            await api(route, { key: `exp_${"x".repeat(48)}`, expected: 401 });
            await api(route, { key: writeKey.key, expected: 403 });
            for (const field of ["revoked_at", "expires_at"]) {
                const credentials = await key(member);
                await api(`/api/collections/api_keys/records/${credentials.record.id}`, { token: admin, method: "PATCH", body: { [field]: "2020-01-01T00:00:00Z" } });
                await api(route, { key: credentials.key, expected: 401 });
            }
        }

        await api(explicit, { token: owner.token, key: outsiderKey.key, expected: 404 });
        assert.deepEqual(await api(path, { token: owner.token, key: memberKey.key }), forKind((await config(member)).categories));
        const combined = await key(member, ["expenses:read", "expenses:write"]);
        assert.deepEqual(await api(path, { key: combined.key }), forKind((await config(member)).categories));
    });
    await t.test("lookup can return only income and rejects unsupported kinds", async () => {
        assert.deepEqual(await api(path + "?kind=income", { key: memberKey.key }), forKind((await config(member)).categories, "income"));
        assert.deepEqual(await api(explicit + "?kind=income", { key: memberKey.key }), forKind((await api(`${root}/${circle.id}`, { token: owner.token })).categories, "income"));
        await api(path + "?kind=transfer", { key: memberKey.key, expected: 400 });
    });
    await t.test("personal lookup includes renamed and archived categories in saved order", async () => {
        await api(`/api/expenditure/categories/${personal.id}`, { token: member.token, method: "PATCH", body: { name: "Archived personal", active: false } });
        const before = forKind((await config(member)).categories).map((row) => row.id);
        await api("/api/expenditure/categories/reorder", { token: member.token, body: { ids: before.toReversed(), previous_ids: before } });
        const categories = await api(path, { key: memberKey.key });
        assert.ok(Array.isArray(categories));
        assert.deepEqual(categories, forKind((await config(member)).categories));
        assert.deepEqual(categories.map((row) => row.id), before.toReversed());
        assert.ok(categories.length > 30);
        assert.equal(categories.find((row) => row.id === personal.id).name, "Archived personal");
        assert.equal(categories.find((row) => row.id === personal.id).active, false);
        assert.ok(categories.every((row) => row.user === member.id && row.key_hash === undefined));
        assert.ok(!categories.some((row) => row.id === shared.id || row.id === other.id));
        const metadata = (await api("/api/expenditure/keys", { token: member.token })).items.find((row) => row.id === memberKey.record.id);
        assert.ok(metadata.last_used);
    });
    await t.test("default lookup follows preference changes and explicit Circles override it", async () => {
        await setDefault(owner, ownerConfig.preferences, circle.id);
        assert.deepEqual(await api(path, { key: ownerKey.key }), await api(explicit, { key: ownerKey.key }));
        assert.ok((await api(path, { key: ownerKey.key })).some((row) => row.id === shared.id));
        assert.ok((await api(secondPath, { key: ownerKey.key })).some((row) => row.id === other.id));
        await setDefault(owner, ownerConfig.preferences, second.id);
        assert.deepEqual(await api(path, { key: ownerKey.key }), await api(secondPath, { key: ownerKey.key }));
        assert.ok((await api(explicit, { key: ownerKey.key })).some((row) => row.id === shared.id));
        await setDefault(owner, ownerConfig.preferences, "");
        assert.deepEqual(await api(path, { key: ownerKey.key }), forKind((await config(owner)).categories));
        assert.ok((await api(explicit, { key: memberKey.key })).some((row) => row.id === shared.id));
    });
    await t.test("ordinary members can read the full Circle category order without Add or management access", async () => {
        await api(`/api/collections/circle_members/records/${membership}`, { token: admin, method: "PATCH", body: { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" } });
        await api(`${root}/${circle.id}/categories/${shared.id}`, { token: owner.token, method: "PATCH", body: { name: "Archived shared", active: false } });
        const before = (await api(explicit, { key: memberKey.key })).map((row) => row.id);
        await api(`${root}/${circle.id}/categories/reorder`, { token: owner.token, body: { ids: before.toReversed(), previous_ids: before } });
        const categories = await api(explicit, { key: memberKey.key });
        assert.deepEqual(categories, forKind((await api(`${root}/${circle.id}`, { token: owner.token })).categories));
        assert.deepEqual(categories.map((row) => row.id), before.toReversed());
        assert.ok(categories.length > 30);
        assert.equal(categories.find((row) => row.id === shared.id).name, "Archived shared");
        assert.equal(categories.find((row) => row.id === shared.id).active, false);
        assert.ok(categories.every((row) => row.circle === circle.id));
        assert.ok(!categories.some((row) => row.id === personal.id || row.id === other.id));
        await setDefault(member, memberConfig.preferences, circle.id);
        assert.deepEqual(await api(path, { key: memberKey.key }), categories);
    });
    await t.test("non-members, inactive memberships and missing defaults never expose or fall back to personal categories", async () => {
        await api(explicit, { key: outsiderKey.key, expected: 404 });
        await api(secondPath, { key: memberKey.key, expected: 404 });
        await api("/api/expenses/circles/not-an-id/categories", { key: ownerKey.key, expected: 404 });
        await api(`/api/expenses/circles/${"z".repeat(15)}/categories`, { key: ownerKey.key, expected: 404 });
        await api(`/api/collections/circle_members/records/${membership}`, { token: admin, method: "PATCH", body: { active: false } });
        await api(explicit, { token: owner.token, key: memberKey.key, expected: 404 });
        await api(path, { key: memberKey.key, expected: 404 });
        await setDefault(member, memberConfig.preferences, "");
        assert.deepEqual(await api(path, { key: memberKey.key }), forKind((await config(member)).categories));
        await setDefault(owner, ownerConfig.preferences, second.id);
        await api(`${root}/${second.id}`, { token: owner.token, method: "DELETE", body: { confirmation: second.name, version: second.version } });
        await api(path, { key: ownerKey.key, expected: 404 });
        await api(secondPath, { key: ownerKey.key, expected: 404 });
        await setDefault(owner, ownerConfig.preferences, "");
        assert.deepEqual(await api(path, { key: ownerKey.key }), forKind((await config(owner)).categories));
    });
});
