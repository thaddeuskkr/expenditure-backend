import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Circle member permissions cover each action and every creation path", { timeout: 60000 }, async (t) => {
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

    const owner = await user("Owner"), member = await user("Member"), other = await user("Other"), outsider = await user("Outsider");
    const root = "/api/expenditure/circles";
    const detail = (g, actor = owner) => api(g.path, { token: actor.token });
    async function group() {
        const circle = await api(root, { token: owner.token, body: { name: "Permissions", currency: "SGD" }, expected: 201 });
        const g = { circle, path: `${root}/${circle.id}`, ids: { owner: (await api(`${root}/${circle.id}`, { token: owner.token })).me } };
        for (const [name, account] of [["member", member], ["other", other]]) {
            const invitation = await api(`${g.path}/invitations`, { token: owner.token, body: { email: account.email }, expected: 201 });
            g.ids[name] = (await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: account.token, body: {} })).member;
        }

        return g;
    }

    const permissionPath = (g, id = g.ids.member) => `${g.path}/members/${id}/permissions`;
    async function permission(g, overrides = {}, target = "member") {
        const saved = (await detail(g)).members.find((row) => row.id === g.ids[target]);
        return api(permissionPath(g, saved.id), { token: owner.token, method: "PATCH", body: { is_admin: saved.is_admin, can_add: saved.can_add, edit_scope: saved.edit_scope, delete_scope: saved.delete_scope, move_scope: saved.move_scope, version: saved.version, ...overrides } });
    }

    const fields = (g, overrides = {}) => ({ title: "Shared entry", kind: "expense", amount: 1000, currency: "SGD", category: "Other", paid_by: g.ids.member, split_mode: "even", shares: [{ member: g.ids.member }, { member: g.ids.other }], occurred_at: "2091-01-01T00:00:00Z", ...overrides });
    const create = (g, actor = member, overrides = {}) => api(`${g.path}/expenses`, { token: actor.token, body: fields(g, overrides), expected: 201 });
    const edit = (g, entry, actor = member, expected = 200) => api(`${g.path}/expenses/${entry.id}`, { token: actor.token, method: "PATCH", body: { ...fields(g, { category: entry.category, kind: entry.kind, title: "Changed" }), version: entry.version }, expected });
    const remove = (g, entry, actor = member, expected = 200) => api(`${g.path}/expenses/${entry.id}`, { token: actor.token, method: "DELETE", body: { version: entry.version }, expected });
    const move = (g, entry, actor = member, expected = 200) => api(`${g.path}/expenses/${entry.id}/move-to-personal`, { token: actor.token, body: { version: entry.version }, expected });
    const key = (actor = member) => api("/api/expenditure/keys", { token: actor.token, body: { name: "Permission test", scopes: ["expenses:write"], expires_at: "" }, expected: 201 });
    await t.test("new members keep own-entry defaults and owners receive full effective access", async () => {
        const g = await group();
        for (const actor of [member, other]) {
            const d = await detail(g, actor);
            assert.deepEqual(d.circle.permissions, { can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer" });
            const me = d.members.find((row) => row.id === d.me);
            assert.equal(me.version, 1);
            assert.equal(me.is_admin, false);
            assert.equal(d.circle.can_manage, false);
            assert.equal(me.can_add, true);
            assert.equal(me.edit_scope, "own");
            assert.equal(me.delete_scope, "own");
        }

        assert.deepEqual((await detail(g)).circle.permissions, { can_add: true, edit_scope: "all", delete_scope: "all", move_scope: "all" });
        assert.deepEqual((await api(root, { token: member.token })).circles.find((row) => row.id === g.circle.id).permissions, { can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer" });
    });
    await t.test("permission writes require management access, a matching active member, strict fields and current version", async () => {
        const g = await group(), foreign = await group();
        const body = { is_admin: false, can_add: false, edit_scope: "none", delete_scope: "all", move_scope: "none", version: 1 };
        await api(permissionPath(g), { body, method: "PATCH", expected: 401 });
        await api(permissionPath(g), { token: member.token, body, method: "PATCH", expected: 403 });
        await api(permissionPath(g), { token: outsider.token, body, method: "PATCH", expected: 404 });
        await api(permissionPath(g, g.ids.owner), { token: owner.token, body, method: "PATCH", expected: 400 });
        await api(permissionPath(g, foreign.ids.member), { token: owner.token, body, method: "PATCH", expected: 404 });
        for (const invalid of [{ move_scope: "own" }, { move_scope: true }, { is_admin: "true" }, { can_add: "false" }, { edit_scope: "owner" }, { delete_scope: true }, { paid_by: g.ids.member }, { version: 0 }, { version: 1.5 }])
            await api(permissionPath(g), { token: owner.token, body: { ...body, ...invalid }, method: "PATCH", expected: "version" in invalid ? 409 : 400 });
        const results = await Promise.all(["own", "all"].map(async (edit_scope) => {
            const response = await fetch(base + permissionPath(g), { method: "PATCH", headers: { Authorization: owner.token, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, edit_scope }) });
            return response.status;
        }));
        assert.deepEqual(results.sort(), [200, 409]);
        await api(`/api/collections/circle_members/records/${g.ids.member}`, { token: member.token, method: "PATCH", body: { can_add: true }, expected: 403 });
        await api(`${g.path}/members/${g.ids.other}`, { token: owner.token, method: "DELETE" });
        await api(permissionPath(g, g.ids.other), { token: owner.token, body, method: "PATCH", expected: 404 });
    });
    await t.test("Edit and Delete scopes are independent for expenses and income; own means author rather than payer", async () => {
        const g = await group();
        for (const kind of ["expense", "income"]) {
            let own = await create(g, member, { kind, paid_by: g.ids.other });
            let foreign = await create(g, other, { kind });
            own = await edit(g, own);
            await edit(g, foreign, member, 403);
            await remove(g, foreign, member, 403);
            await permission(g, { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
            await edit(g, own, member, 403);
            await remove(g, own, member, 403);
            await api(`${g.path}/expenses`, { token: member.token, body: fields(g, { kind }), expected: 403 });
            foreign = await edit(g, foreign, owner);
            await permission(g, { edit_scope: "all" });
            foreign = await edit(g, foreign);
            await remove(g, foreign, member, 403);
            await permission(g, { edit_scope: "none", delete_scope: "all" });
            await edit(g, foreign, member, 403);
            await remove(g, foreign);
            await permission(g, { delete_scope: "own" });
            await remove(g, own);
            await permission(g, { can_add: true, edit_scope: "own" });
        }
    });
    await t.test("Move access is independent of Add, Edit and Delete for expenses and income", async () => {
        const g = await group();
        for (const kind of ["expense", "income"]) {
            const otherPayer = await create(g, other, { kind, paid_by: g.ids.other });
            const paid = await create(g, other, { kind });
            await permission(g, { can_add: false, edit_scope: "all", delete_scope: "all", move_scope: "none" });
            await move(g, paid, member, 403);
            await move(g, otherPayer, member, 403);
            await permission(g, { edit_scope: "none", delete_scope: "none", move_scope: "payer" });
            await edit(g, paid, member, 403);
            await remove(g, paid, member, 403);
            await move(g, otherPayer, member, 403);
            const personal = await move(g, paid);
            assert.equal(personal.user, member.id);
            assert.equal(personal.kind, kind);
            assert.equal(personal.amount, paid.amount);
            await move(g, paid, member, 404);
            await permission(g, { move_scope: "all" });
            const movedOther = await move(g, otherPayer);
            assert.equal(movedOther.user, member.id);
            assert.equal(movedOther.amount, otherPayer.amount);
            assert.equal(movedOther.kind, kind);
            assert.equal((await api(`/api/collections/expenses/records/${movedOther.id}`, { token: member.token })).user, member.id);
            await permission(g, { can_add: true });
        }
    });
    await t.test("concurrent moves by different authorized members create one personal entry for the winner", async () => {
        const g = await group(), entry = await create(g, owner, { title: "Concurrent Move all" });
        await permission(g, { edit_scope: "none", move_scope: "all" });
        await permission(g, { edit_scope: "none", move_scope: "all" }, "other");
        const before = await Promise.all([member, other].map((actor) => api("/api/collections/expenses/records", { token: actor.token })));
        const results = await Promise.all([member, other].map(async (actor) => {
            const response = await fetch(base + `${g.path}/expenses/${entry.id}/move-to-personal`, { method: "POST", headers: { Authorization: actor.token, "Content-Type": "application/json" }, body: JSON.stringify({ version: entry.version }) });
            return { status: response.status, result: await response.json(), actor };
        }));
        assert.deepEqual(results.map((row) => row.status).sort(), [200, 404]);
        const winner = results.find((row) => row.status === 200);
        assert.equal(winner.result.user, winner.actor.id);
        const after = await Promise.all([member, other].map((actor) => api("/api/collections/expenses/records", { token: actor.token })));
        assert.equal(after[0].totalItems + after[1].totalItems, before[0].totalItems + before[1].totalItems + 1);
        assert.equal((await detail(g)).expenses.totalItems, 0);
    });
    await t.test("Move all still protects former member balances and revocation blocks an already-open entry", async () => {
        const g = await group(), entry = await create(g, owner, { paid_by: g.ids.owner });
        await permission(g, { edit_scope: "none", move_scope: "all" });
        await api(`/api/collections/circle_members/records/${g.ids.other}`, { token: admin, method: "PATCH", body: { active: false } });
        const before = await detail(g), personalBefore = await api("/api/collections/expenses/records", { token: member.token });
        await move(g, entry, member, 400);
        assert.deepEqual((await detail(g)).balances, before.balances);
        assert.equal((await api("/api/collections/expenses/records", { token: member.token })).totalItems, personalBefore.totalItems);
        await api(`/api/collections/circle_members/records/${g.ids.other}`, { token: admin, method: "PATCH", body: { active: true } });
        await permission(g, { edit_scope: "all", move_scope: "none" });
        await move(g, entry, member, 403);
        await permission(g, { move_scope: "all" });
        await move(g, entry);
    });
    await t.test("API imports and default destinations require Add; accepted retries still replay after revocation", async () => {
        const g = await group(), credential = await key();
        const body = { title: "Imported", amount: 650 }, idempotency = "permissions-import";
        async function imported(input, expected, path = `/api/expenses/circles/${g.circle.id}/transactions`, retryKey = idempotency) {
            const response = await fetch(base + path, { method: "POST", headers: { "X-API-Key": credential.key, "Idempotency-Key": retryKey, "Content-Type": "application/json" }, body: JSON.stringify(input) });
            const result = await response.json();
            assert.equal(response.status, expected, JSON.stringify(result));
            return result;
        }

        const accepted = await imported(body, 201);
        await permission(g, { can_add: false });
        assert.equal((await imported(body, 200)).id, accepted.id);
        await imported(body, 403, undefined, "new-blocked");
        const config = await api("/api/expenditure/config", { token: member.token });
        await api(`/api/collections/preferences/records/${config.preferences.id}`, { token: member.token, method: "PATCH", body: { default_api_circle: g.circle.id } });
        await imported({ merchant: "Default blocked", amount: 650 }, 403, "/api/expenses/transactions", "default-blocked");
        assert.equal((await imported({ merchant: "Imported", amount: 650 }, 200, "/api/expenses/transactions")).id, accepted.id);
        await permission(g, { can_add: true });
        await imported(body, 201, undefined, "new-blocked");
    });
    await t.test("moving personal entries into a Circle requires Add without blocking confirmed retries", async () => {
        const g = await group();
        const personal = await api("/api/collections/expenses/records", { token: member.token, body: { user: member.id, kind: "expense", merchant: "Personal", amount: 650, currency: "SGD", category: "Other", occurred_at: "2091-01-01T00:00:00Z" } });
        const body = { expense: personal.id, previous_updated: personal.updated, category: (await detail(g)).categories.find((row) => row.name === "Other").id };
        await permission(g, { can_add: false });
        await api(`${g.path}/expenses/move`, { token: member.token, body, expected: 403 });
        assert.equal((await api(`/api/collections/expenses/records/${personal.id}`, { token: member.token })).moved_to, "");
        await permission(g, { can_add: true });
        const shared = await api(`${g.path}/expenses/move`, { token: member.token, body });
        await permission(g, { can_add: false });
        assert.equal((await api(`${g.path}/expenses/move`, { token: member.token, body })).id, shared.id);
    });
    await t.test("revoking Add pauses recurring expenses and income without advancing cursors or changing history", async () => {
        const g = await group();
        for (const kind of ["expense", "income"])
            await create(g, member, { title: `Scheduled ${kind}`, kind, recurrence: "daily", recurrence_interval: 1 });
        const before = await detail(g);
        await permission(g, { can_add: false });
        await api("/api/test/move-recurrence", { token: admin, body: { now: Date.parse("2091-01-02T00:00:00Z") } });
        const paused = await detail(g);
        assert.equal(paused.expenses.totalItems, 2);
        for (const entry of paused.recurring) {
            assert.match(entry.recurrence_error, /permission.*add/i);
            assert.equal(entry.recurrence_next, before.recurring.find((row) => row.id === entry.id).recurrence_next);
        }

        await permission(g, { can_add: true });
        for (const entry of paused.recurring)
            await api(`${g.path}/expenses/${entry.id}`, { token: member.token, method: "PATCH", body: { ...fields(g, { title: entry.title, kind: entry.kind, category: entry.category, recurrence: "daily", recurrence_interval: 1 }), version: entry.version } });
        await api("/api/test/move-recurrence", { token: admin, body: { now: Date.parse("2091-01-02T00:00:00Z") } });
        assert.equal((await detail(g)).expenses.totalItems, 4);
    });
    await t.test("restricted members can still record and edit their repayments", async () => {
        const g = await group();
        await create(g, owner);
        await permission(g, { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        const payment = await api(`${g.path}/settlements`, { token: member.token, body: { from_member: g.ids.other, to_member: g.ids.member, amount: 100, currency: "SGD", notes: "External payment" }, expected: 201 });
        const updated = await api(`${g.path}/settlements/${payment.id}`, { token: member.token, method: "PATCH", body: { from_member: payment.from_member, to_member: payment.to_member, amount: payment.amount, currency: payment.currency, notes: "Updated", version: payment.version } });
        assert.equal(updated.notes, "Updated");
        await api(`${g.path}/settlements/${payment.id}`, { token: member.token, method: "DELETE", body: { version: updated.version } });
    });
    await t.test("Admins inherit full transaction access and manage settings, categories and invitations", async () => {
        const g = await group();
        const seed = await create(g, owner);
        await permission(g, { is_admin: true, can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        let d = await detail(g, member);
        assert.equal(d.circle.is_owner, false);
        assert.equal(d.circle.can_manage, true);
        assert.deepEqual(d.circle.permissions, { can_add: true, edit_scope: "all", delete_scope: "all", move_scope: "all" });
        assert.equal((await api(root, { token: member.token })).circles.find((row) => row.id === g.circle.id).can_manage, true);
        const renamed = await api(g.path, { token: member.token, method: "PATCH", body: { name: "Admin renamed", icon: "home", currency: "JPY", version: d.circle.version } });
        assert.equal(renamed.name, "Admin renamed");
        assert.equal(renamed.owner, owner.id);
        const category = await api(`${g.path}/categories`, { token: member.token, body: { name: "Admin category", color: "#123456" }, expected: 201 });
        await api(`${g.path}/categories/${category.id}`, { token: member.token, method: "PATCH", body: { name: "Admin renamed category", active: false } });
        d = await detail(g, member);
        const previous_ids = d.categories.filter((row) => row.kind === "expense").map((row) => row.id);
        await api(`${g.path}/categories/reorder`, { token: member.token, method: "POST", body: { previous_ids, ids: [...previous_ids].reverse() } });
        d = await detail(g, member);
        await api(`${g.path}/categories/copy`, { token: member.token, body: { previous_ids: d.categories.filter((row) => row.kind === "expense").map((row) => row.id) } });
        const invitation = await api(`${g.path}/invitations`, { token: member.token, body: { email: outsider.email }, expected: 201 });
        assert.ok((await detail(g, member)).invitations.some((row) => row.id === invitation.id));
        await api(`/api/expenditure/circle-invitations/${invitation.id}`, { token: member.token, method: "DELETE" });
        const created = await create(g, member);
        await create(g, member, { kind: "income" });
        await remove(g, await edit(g, seed));
        await remove(g, created);
        const credential = await key();
        await api(`/api/expenses/circles/${g.circle.id}/transactions`, { key: credential.key, body: { title: "Admin import", amount: 650 }, expected: 201 });
    });
    await t.test("Admins manage other members and permissions while the owner, ownership and Circle deletion remain protected", async () => {
        const g = await group();
        await permission(g, { is_admin: true });
        let d = await detail(g, member), target = d.members.find((row) => row.id === g.ids.other);
        await api(permissionPath(g, target.id), { token: member.token, method: "PATCH", body: { is_admin: true, can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none", version: target.version } });
        assert.equal((await detail(g, other)).circle.can_manage, true);
        target = (await detail(g, member)).members.find((row) => row.id === g.ids.other);
        await api(permissionPath(g, target.id), { token: member.token, method: "PATCH", body: { is_admin: false, can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer", version: target.version } });
        await api(`${g.path}/members/${g.ids.owner}`, { token: member.token, method: "DELETE", expected: 400 });
        target = (await detail(g, member)).members.find((row) => row.id === g.ids.owner);
        await api(permissionPath(g, target.id), { token: member.token, method: "PATCH", body: { is_admin: false, can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none", version: target.version }, expected: 400 });
        for (const next of [member.id, other.id])
            await api(g.path, { token: member.token, method: "PATCH", body: { name: "Must roll back", owner: next, version: d.circle.version }, expected: 403 });
        assert.equal((await detail(g)).circle.name, g.circle.name);
        await api(g.path, { token: member.token, method: "DELETE", body: { confirmation: g.circle.name, version: d.circle.version }, expected: 403 });
        await create(g, owner, { paid_by: g.ids.other });
        await api(`${g.path}/members/${g.ids.other}`, { token: member.token, method: "DELETE", expected: 400 });
        const debts = await detail(g, member);
        await api(`${g.path}/settlements`, { token: member.token, body: { ...debts.suggestions[0] }, expected: 201 });
        await api(`${g.path}/members/${g.ids.other}`, { token: member.token, method: "DELETE" });
        assert.equal((await detail(g)).members.find((row) => row.id === g.ids.owner).active, true);
        assert.equal((await detail(g)).members.find((row) => row.id === g.ids.other).active, false);
    });
    await t.test("Admins can record, edit and undo repayments between other members and lose access immediately when demoted", async () => {
        const g = await group();
        await create(g, owner, { paid_by: g.ids.owner, shares: [{ member: g.ids.other }] });
        const recorded = await api(`${g.path}/settlements`, { token: owner.token, body: { from_member: g.ids.other, to_member: g.ids.owner, amount: 100, currency: "SGD", notes: "Owner recorded" }, expected: 201 });
        await permission(g, { is_admin: true, can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        const updated = await api(`${g.path}/settlements/${recorded.id}`, { token: member.token, method: "PATCH", body: { from_member: g.ids.other, to_member: g.ids.owner, amount: 200, currency: "SGD", notes: "Admin edited", version: recorded.version } });
        assert.equal(updated.created_by, g.ids.owner);
        await api(`${g.path}/settlements/${recorded.id}`, { token: member.token, method: "DELETE", body: { version: updated.version } });
        await api(`${g.path}/settlements`, { token: member.token, body: { from_member: g.ids.other, to_member: g.ids.owner, amount: 100, currency: "SGD" }, expected: 201 });
        await permission(g, { is_admin: false });
        let d = await detail(g, member);
        assert.equal(d.circle.can_manage, false);
        assert.deepEqual(d.circle.permissions, { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        await api(g.path, { token: member.token, method: "PATCH", body: { name: "Denied", version: d.circle.version }, expected: 403 });
        await api(`${g.path}/categories`, { token: member.token, body: { name: "Denied", color: "#123456" }, expected: 403 });
        await api(`${g.path}/invitations`, { token: member.token, body: { email: outsider.email }, expected: 403 });
        const adminKey = await key();
        await api(`/api/expenses/circles/${g.circle.id}/transactions`, { key: adminKey.key, body: { title: "Denied", amount: 650 }, expected: 403 });
    });
    await t.test("Owners and Admins have full Move access; demotion restores the saved scope", async () => {
        const g = await group();
        await permission(g, { is_admin: true, edit_scope: "none", move_scope: "none" });
        const notPayer = await create(g, owner, { paid_by: g.ids.owner });
        assert.equal((await move(g, notPayer, member)).user, member.id);
        const paid = await create(g, owner);
        assert.equal((await move(g, paid, owner)).user, owner.id);
        await permission(g, { is_admin: false });
        const blocked = await create(g, owner);
        await move(g, blocked, member, 403);
    });
    await t.test("rejoining retains restrictions and ownership transfer immediately changes effective access", async () => {
        const g = await group();
        await permission(g, { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        await api(`${g.path}/members/${g.ids.member}`, { token: member.token, method: "DELETE" });
        const invitation = await api(`${g.path}/invitations`, { token: owner.token, body: { email: member.email }, expected: 201 });
        const joined = await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, { token: member.token, body: {} });
        assert.equal(joined.member, g.ids.member);
        assert.deepEqual((await detail(g, member)).circle.permissions, { can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none" });
        const circle = (await detail(g)).circle;
        await api(g.path, { token: owner.token, method: "PATCH", body: { owner: member.id, version: circle.version } });
        assert.deepEqual((await detail(g, member)).circle.permissions, { can_add: true, edit_scope: "all", delete_scope: "all", move_scope: "all" });
        assert.deepEqual((await detail(g, owner)).circle.permissions, { can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer" });
        await create(g, member);
        await api(permissionPath(g, g.ids.other), { token: owner.token, method: "PATCH", body: { is_admin: false, can_add: false, edit_scope: "none", delete_scope: "none", move_scope: "none", version: 1 }, expected: 403 });
    });
});
