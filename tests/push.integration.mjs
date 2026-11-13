import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

test("Circle push recipients, transactional outbox, device isolation and delivery retries", { timeout: 90000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to PocketBase 0.40.6.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-push-"));
    const hooks = join(directory, "hooks");
    await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
    // This route exists only in this disposable test server, never product hooks.
    await writeFile(join(hooks, "test-push.pb.js"), `
routerAdd("POST", "/test/push/reset-cooldown/{id}", (e) => {
    e.app.store().remove("expenditure_push_test_" + e.request.pathValue("id"));
    return e.json(200, {});
}, $apis.requireAuth("_superusers"));
routerAdd("POST", "/test/push/run", (e) => { require(__hooks + "/push.js").deliver(e.app);
return e.json(200, {});
}, $apis.requireAuth("_superusers"));
routerAdd("POST", "/test/push/rollback/{id}", (e) => {
    e.app.runInTransaction((app) => {
        const source = app.findRecordById("circle_expenses", e.request.pathValue("id"));
        const record = new Record(app.findCollectionByNameOrId("circle_expenses"));
        const data = source.publicExport();
delete data.id;
delete data.created;
delete data.updated;
        record.load(data);
app.save(record);
throw new BadRequestError("Forced rollback");
    });
}, $apis.requireAuth("_superusers"));
routerAdd("POST", "/test/push/recurring", (e) => {
    require(__hooks + "/recurrence.js").run(e.app, e.requestInfo().body.now);
    return e.json(200, {});
}, $apis.requireAuth("_superusers"));
routerAdd("POST", "/test/push/rollback-record/{collection}/{id}", (e) => {
    const name = e.request.pathValue("collection");
    if (!["expenses", "circle_invitations", "circle_settlements"].includes(name)) throw new BadRequestError("Invalid collection");
    e.app.runInTransaction((app) => {
        const data = app.findRecordById(name, e.request.pathValue("id")).publicExport();
        delete data.id;
        delete data.created;
        delete data.updated;
        const record = new Record(app.findCollectionByNameOrId(name));
        record.load(data);
        app.save(record);
        throw new BadRequestError("Forced rollback");
    });
}, $apis.requireAuth("_superusers"));
`);
    let responseMode = "sent", responseStatus = 200, responseDelay = 0;
    const deliveries = [];
    const secret = randomBytes(32).toString("hex");
    const relay = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${secret}`);
        let text = "";
        for await (const chunk of req) text += chunk;
        deliveries.push(JSON.parse(text));
        if (responseDelay) await new Promise((done) => setTimeout(done, responseDelay));
        res.setHeader("Content-Type", "application/json");
        res.statusCode = responseStatus;
        res.end(JSON.stringify({ result: responseMode }));
    });
    await new Promise((done) => relay.listen(0, "127.0.0.1", done));
    const allocator = createServer();
    await new Promise((done) => allocator.listen(0, "127.0.0.1", done));
    const port = allocator.address().port;
    await new Promise((done) => allocator.close(done));
    const password = randomBytes(24).toString("hex");
    const flags = [`--dir=${join(directory, "data")}`, `--hooksDir=${hooks}`, `--migrationsDir=${resolve("pocketbase/pb_migrations")}`];
    const setup = spawnSync(binary, ["superuser", "upsert", "admin@example.com", password, ...flags], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const server = spawn(binary, ["serve", "--automigrate=false", "--hooksWatch=false", `--http=127.0.0.1:${port}`, ...flags], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, EXPENDITURE_PUSH_RELAY_URL: `http://127.0.0.1:${relay.address().port}/send`, EXPENDITURE_PUSH_RELAY_SECRET: secret },
    });
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

        await new Promise((done) => relay.close(done));
        await rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(base + "/api/health")).ok) break;
        } catch {}

        if (i === 99) assert.fail(logs);
        await new Promise((done) => setTimeout(done, 25));
    }

    async function api(path, token, body, method = body === undefined ? "GET" : "POST", expected = 200) {
        const res = await fetch(base + path, { method,
            headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text(), data = text ? JSON.parse(text) : null;
        assert.equal(res.status, expected, JSON.stringify({ path, data }) + (res.status >= 500 ? logs : ""));
        return data;
    }

    const admin = (await api("/api/collections/_superusers/auth-with-password", null, { identity: "admin@example.com", password })).token;
    async function user(name) {
        const record = await api("/api/collections/users/records", admin, { name, email: `${name}@example.com`, verified: true, password, passwordConfirm: password });
        const auth = await api("/api/collections/users/auth-with-password", null, { identity: record.email, password });
        return { ...record, token: auth.token };
    }

    const alice = await user("Alice"), bob = await user("Bob"), carol = await user("Carol"), outsider = await user("Outside");
    const root = "/api/expenditure/circles";
    const circle = await api(root, alice.token, { name: "Push trip", icon: "plane", currency: "SGD" }, "POST", 201);
    const aliceMember = (await api(`${root}/${circle.id}`, alice.token)).me;
    const members = {};
    for (const person of [bob, carol]) {
        const invite = await api(`${root}/${circle.id}/invitations`, alice.token, { email: person.email }, "POST", 201);
        members[person.id] = (await api(`/api/expenditure/circle-invitations/${invite.id}/accept`, person.token, {})).member;
    }

    const installations = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const tokens = ["aa", "bb", "cc", "dd", "ee"].map((prefix) => prefix.repeat(32));
    async function register(person, i, override = {}) {
        return api(`/api/expenditure/push/devices/${installations[i]}`, person.token,
            { token: tokens[i], environment: "sandbox", server: base, circle_expenses: true, circle_invitations: true, repayments: true, shortcut_expenses: false, api_expenses: false, ...override }, "PUT");
    }

    const list = async (collection) => (await api(`/api/collections/${collection}/records?perPage=100`, admin)).items;
    const run = async () => api("/test/push/run", admin, {});
    for (const name of ["push_devices", "push_deliveries"]) {
        await api(`/api/collections/${name}/records`, bob.token, undefined, "GET", 403);
        await api(`/api/collections/${name}/records`, bob.token, {}, "POST", 403);
    }

    await api(`/api/expenditure/push/devices/${installations[0]}`, null, { token: tokens[0], environment: "sandbox", server: base }, "PUT", 401);
    await api(`/api/expenditure/push/devices/${installations[0]}`, bob.token, { token: "invalid", environment: "sandbox", server: base }, "PUT", 400);
    await register(alice, 0);
    await register(bob, 1);
    await register(bob, 2);
    await register(carol, 3);
    await register(outsider, 4);
    await register(bob, 1);
    // No duplicate registration.
    assert.equal((await list("push_devices")).length, 5);
    const carolMember = members[carol.id];
    await api(`/api/collections/circle_members/records/${carolMember}`, admin, { active: false }, "PATCH");
    const categories = (await api(`${root}/${circle.id}`, alice.token)).categories;
    async function expense(fields = {}) {
        return api(`${root}/${circle.id}/expenses`, alice.token, {
            title: "Dinner", amount: 1234, currency: "SGD", category: categories.find((row) => row.kind === (fields.kind ?? "expense") && row.active).id, paid_by: members[bob.id],
            split_mode: "even", shares: [{ member: aliceMember }, { member: members[bob.id] }],
            occurred_at: "2026-11-08T12:00:00+08:00", ...fields,
        }, "POST", 201);
    }

    const first = await expense();
    let jobs = await list("push_deliveries");
    assert.equal(jobs.length, 2, "Only Bob's two devices: exclude author Alice, inactive Carol and outsider");
    assert.ok(jobs.every((job) => job.payload.user === bob.id && job.payload.circle === circle.id && job.payload.server === base));
    assert.equal(jobs[0].payload.aps.alert.title, "Push trip");
    assert.equal(jobs[0].payload.aps.alert.body, "Alice spent SGD 12.34 at Dinner");
    await api(`${root}/${circle.id}/expenses/${first.id}`, alice.token, { version: first.version, title: "Updated dinner", amount: first.amount, currency: first.currency, category: first.category, paid_by: first.paid_by, split_mode: "even", shares: [{ member: aliceMember }, { member: members[bob.id] }], occurred_at: "2026-11-08T12:00:00+08:00" }, "PATCH");
    await expense({ kind: "income", title: "Refund" });
    assert.equal((await list("push_deliveries")).length, 2, "Edits and income do not notify");
    const before = (await list("circle_expenses")).length;
    await api(`/test/push/rollback/${first.id}`, admin, {}, "POST", 400);
    assert.equal((await list("circle_expenses")).length, before);
    assert.equal((await list("push_deliveries")).length, 2, "Rolled-back writes leave no delivery");
    await Promise.all([run(), run()]);
    assert.equal((await list("push_deliveries")).length, 0);
    assert.deepEqual(deliveries.map((row) => row.token).sort(), [tokens[1], tokens[2]].sort());
    assert.equal(deliveries[0].payload.aps["thread-id"], circle.id);

    // Replays must not create another outbox item (uses the real API-key path).
    const key = await api("/api/expenditure/keys", alice.token, { name: "Push test", scopes: ["expenses:write"], expires_at: "" }, "POST", 201);
    const keyToken = key.key;
    assert.equal(typeof keyToken, "string");
    const apiBody = { title: "Imported coffee", amount: 650, currency: "SGD" };
    async function imported() {
        const res = await fetch(`${base}/api/expenses/circles/${circle.id}/transactions`, { method: "POST", headers: { "X-API-Key": keyToken, "Content-Type": "application/json", "Idempotency-Key": "push-import" }, body: JSON.stringify(apiBody) });
        const data = await res.json();
        assert.ok(res.ok, JSON.stringify(data));
        return data;
    }

    await imported();
    const count = (await list("push_deliveries")).length;
    await imported();
    assert.equal((await list("push_deliveries")).length, count, "Idempotent API replay never enqueues");
    await run();

    await expense({ title: "Retry me" });
    responseMode = "retry";
    await run();
    jobs = await list("push_deliveries");
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.attempts === 1 && Date.parse(job.next_attempt) > Date.now()));
    for (const job of jobs) await api(`/api/collections/push_deliveries/records/${job.id}`, admin, { next_attempt: "2020-01-01T00:00:00Z" }, "PATCH");
    responseMode = "invalid";
    await run();
    assert.equal((await list("push_deliveries")).length, 0);
    assert.equal((await list("push_devices")).filter((row) => row.user === bob.id).length, 0, "Invalid APNs tokens are removed");

    await register(bob, 1);
    await register(bob, 2);
    const doomed = await expense();
    await api(`${root}/${circle.id}/expenses/${doomed.id}`, alice.token, { version: doomed.version }, "DELETE", 200);
    assert.equal((await list("push_deliveries")).length, 0, "Expense deletion cancels pending alerts");
    await expense();
    await api(`/api/expenditure/push/devices/${installations[1]}`, outsider.token, undefined, "DELETE", 204);
    assert.equal((await list("push_deliveries")).length, 2, "Another user cannot revoke Bob's installation");
    await register(outsider, 1);
    assert.equal((await list("push_deliveries")).length, 1, "Account switching drops previous pending alerts");
    await api(`/api/expenditure/push/devices/${installations[1]}`, bob.token, undefined, "DELETE", 204);
    assert.ok((await list("push_devices")).some((row) => row.installation === installations[1] && row.user === outsider.id), "Late cleanup cannot revoke a transferred device");
    await api(`/api/collections/circle_members/records/${members[bob.id]}`, admin, { active: false }, "PATCH");
    const sentBefore = deliveries.length;
    responseMode = "sent";
    await run();
    assert.equal(deliveries.length, sentBefore, "Removed members are rechecked before delivery");
    assert.equal((await list("push_deliveries")).length, 0);

    async function preferences(person, i, overrides = {}) {
        return api(`/api/expenditure/push/devices/${installations[i]}`, person.token,
            { circle_expenses: true, circle_invitations: true, repayments: true, shortcut_expenses: false, api_expenses: false, ...overrides }, "PATCH", 204);
    }

    await t.test("invitation alerts match verified recipients and cancel on replacement, revocation, expiry, acceptance and opt-out", async () => {
        await register(outsider, 1);
        await register(outsider, 4, { circle_invitations: false });
        const invite = () => api(`${root}/${circle.id}/invitations`, alice.token, { email: outsider.email }, "POST", 201);
        const firstInvite = await invite();
        let pending = await list("push_deliveries");
        assert.equal(pending.length, 1, "Invitation choice is independent on each device");
        assert.equal(pending[0].payload.type, "circle_invitation");
        assert.equal(pending[0].payload.user, outsider.id);
        assert.equal(pending[0].payload.invitation, firstInvite.id);
        assert.equal(pending[0].member, "", "An invited user has no membership yet");
        const replacement = await invite();
        assert.equal((await list("push_deliveries")).length, 2, "Different invitations can coexist in the outbox");
        const start = deliveries.length;
        await run();
        assert.equal(deliveries.length, start + 1, "A superseded invitation is not delivered");
        assert.equal(deliveries.at(-1).payload.invitation, replacement.id);
        const revoked = await invite();
        await api(`/api/expenditure/circle-invitations/${revoked.id}`, alice.token, undefined, "DELETE");
        await run();
        assert.equal(deliveries.length, start + 1, "Revoked invitations do not deliver");
        const expired = await invite();
        await api(`/api/collections/circle_invitations/records/${expired.id}`, admin, { expires_at: "2020-01-01T00:00:00Z" }, "PATCH");
        await run();
        assert.equal(deliveries.length, start + 1, "Expired invitations do not deliver");
        await invite();
        await api(`/api/collections/users/records/${outsider.id}`, admin, { email: "changed@example.com" }, "PATCH");
        await run();
        assert.equal(deliveries.length, start + 1, "Recipient email is rechecked before delivery");
        await api(`/api/collections/users/records/${outsider.id}`, admin, { email: outsider.email }, "PATCH");
        outsider.token = (await api("/api/collections/users/auth-with-password", null, { identity: outsider.email, password })).token;
        await invite();
        await preferences(alice, 1, { circle_invitations: false });
        assert.equal((await list("push_deliveries")).length, 1, "Another account cannot modify notification choices");
        await preferences(outsider, 1, { circle_invitations: false });
        assert.equal((await list("push_deliveries")).length, 0, "Disabling invitations cancels queued alerts immediately");
        await invite();
        assert.equal((await list("push_deliveries")).length, 0, "Disabled devices do not enqueue invitations");
        await preferences(outsider, 1);
        const accepted = await invite();
        await api(`/api/expenditure/circle-invitations/${accepted.id}/accept`, outsider.token, {});
        await run();
        assert.equal(deliveries.length, start + 1, "Accepted invitations no longer deliver");
        const unverified = await user("UnverifiedPush");
        await api(`/api/collections/users/records/${unverified.id}`, admin, { verified: false }, "PATCH");
        installations.push(randomUUID());
        tokens.push("ff".repeat(32));
        await register(unverified, 5);
        await api(`${root}/${circle.id}/invitations`, alice.token, { email: unverified.email }, "POST", 201);
        assert.equal((await list("push_deliveries")).length, 0, "Unverified addresses never receive private invitation alerts");
    });

    await t.test("repayments notify only active participants other than the recorder and respect independent preferences", async () => {
        await register(alice, 0);
        await register(bob, 2);
        await register(carol, 3);
        const trip = await api(root, alice.token, { name: "Repayment trip", icon: "plane", currency: "SGD" }, "POST", 201);
        const participant = { [alice.id]: (await api(`${root}/${trip.id}`, alice.token)).me };
        for (const person of [bob, carol]) {
            const invite = await api(`${root}/${trip.id}/invitations`, alice.token, { email: person.email }, "POST", 201);
            participant[person.id] = (await api(`/api/expenditure/circle-invitations/${invite.id}/accept`, person.token, {})).member;
        }

        await run();
        const tripDetail = await api(`${root}/${trip.id}`, alice.token);
        await api(`${root}/${trip.id}/expenses`, alice.token, {
            title: "Group stay", amount: 30000, currency: "SGD", paid_by: participant[alice.id],
            category: tripDetail.categories.find((row) => row.active).id, split_mode: "exact",
            shares: [{ member: participant[bob.id], amount: 15000 }, { member: participant[carol.id], amount: 15000 }],
        }, "POST", 201);
        await run();
        const settle = (actor, amount = 500) => api(`${root}/${trip.id}/settlements`, actor.token, {
            from_member: participant[bob.id], to_member: participant[alice.id], amount, currency: "SGD",
        }, "POST", 201);
        const first = await settle(bob);
        let pending = await list("push_deliveries");
        assert.equal(pending.length, 1);
        assert.equal(pending[0].payload.type, "circle_repayment");
        assert.equal(pending[0].payload.aps.alert.title, "Repayment trip");
        assert.equal(pending[0].payload.user, alice.id, "Notify the other participant, not Bob or unrelated Carol");
        assert.equal(pending[0].payload.settlement, first.id);
        assert.match(pending[0].payload.aps.alert.body, /Bob recorded a repayment of SGD 5.00 from Bob to Alice/);
        await api(`/test/push/rollback-record/circle_settlements/${first.id}`, admin, {}, "POST", 400);
        assert.equal((await list("push_deliveries")).length, 1, "Rolled-back repayments leave no alert");
        const before = deliveries.length;
        await run();
        assert.equal(deliveries.length, before + 1);
        assert.equal(deliveries.at(-1).token, tokens[0]);
        await api(`${root}/${trip.id}/settlements/${first.id}`, alice.token, {
            version: first.version, from_member: first.from_member, to_member: first.to_member,
            amount: first.amount, currency: first.currency, notes: "Corrected note",
        }, "PATCH");
        assert.equal((await list("push_deliveries")).length, 0, "Editing a repayment does not send another recorded alert");
        await api(`/api/collections/circle_members/records/${participant[carol.id]}`, admin, { is_admin: true }, "PATCH");
        await settle(carol);
        pending = await list("push_deliveries");
        assert.deepEqual(pending.map((job) => job.payload.user).sort(), [alice.id, bob.id].sort(), "An Admin recording for others notifies both participants");
        await run();
        await settle(bob, 100);
        await preferences(alice, 0, { repayments: false });
        assert.equal((await list("push_deliveries")).length, 0, "Disabling repayments cancels pending repayment alerts");
        await settle(bob, 100);
        assert.equal((await list("push_deliveries")).length, 0, "Disabled repayment alerts do not enqueue");
        const aliceDevice = (await list("push_devices")).find((device) => device.user === alice.id);
        assert.ok(aliceDevice.circle_expenses && aliceDevice.circle_invitations && !aliceDevice.repayments, "Other notification choices remain enabled");
        await preferences(alice, 0);
        const corrected = await settle(bob, 100);
        await api(`${root}/${trip.id}/settlements/${corrected.id}`, alice.token, {
            version: corrected.version, from_member: corrected.from_member, to_member: corrected.to_member,
            currency: corrected.currency, amount: 200,
        }, "PATCH");
        await run();
        assert.equal((await list("push_deliveries")).length, 0, "A financial correction cancels an outdated repayment alert");
        const doomed = await settle(bob, 100);
        await api(`${root}/${trip.id}/settlements/${doomed.id}`, bob.token, { version: doomed.version }, "DELETE");
        assert.equal((await list("push_deliveries")).length, 0, "Deleted repayments cancel pending alerts");
        const invitation = await api(`${root}/${trip.id}/invitations`, alice.token, { email: outsider.email }, "POST", 201);
        const baseline = (await list("push_deliveries")).length;
        await api(`/test/push/rollback-record/circle_invitations/${invitation.id}`, admin, {}, "POST", 400);
        assert.equal((await list("push_deliveries")).length, baseline, "Rolled-back invitations leave no alert");
        await api(`/api/expenditure/circle-invitations/${invitation.id}`, alice.token, undefined, "DELETE");
        await run();
        await settle(bob, 100);
        await api(`/api/collections/circle_members/records/${participant[alice.id]}`, admin, { active: false }, "PATCH");
        const sent = deliveries.length;
        await run();
        assert.equal(deliveries.length, sent, "Inactive participants are rechecked before repayment delivery");
        assert.equal((await list("push_deliveries")).length, 0);
    });
    await t.test("own Shortcut and API alerts are opt-in, isolated and not repeated by edits, retries, moves or schedules", async () => {
        const config = await api("/api/expenditure/config", alice.token);
        const personalCategory = config.categories.find((row) => row.active).id;
        const main = await api(`${root}/${circle.id}`, alice.token);
        const circleCategory = main.categories.find((row) => row.active).id;
        const automationJobs = async () => (await list("push_deliveries")).filter((job) => ["shortcut_expense", "api_expense"].includes(job.payload.type));
        async function shortcut(path, body) {
            const response = await fetch(base + path, { method: "POST", headers: { Authorization: alice.token,
                "Content-Type": "application/json", "X-Expenditure-Source": "shortcut" }, body: JSON.stringify(body) });
            const result = await response.json();
            assert.ok(response.ok, JSON.stringify(result));
            return result;
        }

        const personalBody = { user: alice.id, merchant: "McDonald's", amount: 1000, currency: "SGD", payment_method: "Trust Link Card", category: personalCategory,
            kind: "expense", occurred_at: "2026-11-08T05:00:00Z", recurrence_weekdays: [] };
        await shortcut("/api/collections/expenses/records", personalBody);
        assert.equal((await automationJobs()).length, 0, "Automation alerts default to disabled");
        await preferences(alice, 0, { shortcut_expenses: true });
        const personal = await shortcut("/api/collections/expenses/records", personalBody);
        let jobs = await automationJobs();
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].payload.user, alice.id);
        assert.equal(jobs[0].payload.type, "shortcut_expense");
        assert.equal(jobs[0].personal_expense, personal.id);
        assert.equal(jobs[0].payload.circle, undefined);
        await api(`/api/collections/expenses/records/${personal.id}`, alice.token, { notes: "Edited note" }, "PATCH");
        assert.equal((await automationJobs()).length, 1, "Editing does not create an automation notification");
        await api(`/test/push/rollback-record/expenses/${personal.id}`, admin, {}, "POST", 400);
        assert.equal((await automationJobs()).length, 1, "Rolled-back personal writes do not notify");
        await run();
        assert.equal(deliveries.at(-1).token, tokens[0]);
        assert.deepEqual(deliveries.at(-1).payload.aps.alert, { title: "Trust Link Card", body: "Spent SGD 10.00 at McDonald's" });
        await shortcut("/api/collections/expenses/records", { ...personalBody, kind: "income", category: config.categories.find((row) => row.kind === "income").id });
        assert.equal((await automationJobs()).length, 0, "Income does not trigger expense alerts");
        async function apiExpense(path, body, retryKey) {
            const response = await fetch(base + path, { method: "POST", headers: { "X-API-Key": keyToken, "Content-Type": "application/json",
                "Idempotency-Key": retryKey }, body: JSON.stringify(body) });
            const result = await response.json();
            assert.ok(response.ok, JSON.stringify(result));
            return result;
        }

        const importBody = { merchant: "API lunch", amount: 1250, currency: "SGD", payment_method: "Trust Link Card" };
        await apiExpense("/api/expenses/transactions", importBody, "disabled-own-api");
        assert.equal((await automationJobs()).length, 0, "Shortcut and API choices are independent");
        await preferences(alice, 0, { api_expenses: true });
        const imported = await apiExpense("/api/expenses/transactions", importBody, "own-api");
        await apiExpense("/api/expenses/transactions", importBody, "own-api");
        jobs = await automationJobs();
        assert.equal(jobs.length, 1, "API retry replays never create a second alert");
        assert.equal(jobs[0].payload.type, "api_expense");
        assert.equal(jobs[0].personal_expense, imported.id);
        assert.equal(jobs[0].payload.aps.alert.body, "Spent SGD 12.50 at API lunch on Trust Link Card");
        await preferences(alice, 0);
        assert.equal((await automationJobs()).length, 0, "Turning API alerts off cancels queued alerts");
        await preferences(alice, 0, { shortcut_expenses: true, api_expenses: true });
        const circleBody = { title: "Shortcut Circle entry", amount: 900, currency: "SGD", category: circleCategory,
            paid_by: main.me, split_mode: "even", shares: [{ member: main.me }] };
        const shared = await shortcut(`${root}/${circle.id}/expenses`, circleBody);
        jobs = await automationJobs();
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].expense, shared.id);
        assert.equal(jobs[0].payload.aps.alert.title, "Push trip");
        assert.equal(jobs[0].payload.aps.alert.body, "Spent SGD 9.00 at Shortcut Circle entry");
        assert.equal(jobs[0].payload.circle, circle.id);
        assert.equal(jobs[0].payload.user, alice.id);
        assert.ok((await list("push_deliveries")).some((job) => job.payload.type === "circle_expense" && job.payload.user === outsider.id), "Other Circle members still receive their own Circle alert");
        const otherMemberAlert = (await list("push_deliveries")).find((job) => job.payload.type === "circle_expense" && job.payload.expense === shared.id);
        assert.equal(otherMemberAlert.payload.aps.alert.title, "Push trip");
        assert.equal(otherMemberAlert.payload.aps.alert.body, "Alice spent SGD 9.00 at Shortcut Circle entry");
        await run();
        await api(`/api/collections/preferences/records/${config.preferences.id}`, alice.token, { default_api_circle: circle.id }, "PATCH");
        const routed = await apiExpense("/api/expenses/transactions", importBody, "own-routed-api");
        await apiExpense("/api/expenses/transactions", importBody, "own-routed-api");
        jobs = await automationJobs();
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].expense, routed.id, "Default API Circle routing notifies the key owner once");
        await run();
        const toMove = await shortcut("/api/collections/expenses/records", personalBody);
        await run();
        const moved = await api(`${root}/${circle.id}/expenses/move`, alice.token,
            { expense: toMove.id, previous_updated: toMove.updated, category: circleCategory });
        assert.equal((await automationJobs()).length, 0, "Moving an existing expense is not a new Shortcut/API call");
        assert.equal(moved.source, "shortcut");
        assert.equal(moved._skip_automation_notification, undefined);
        await api(`${root}/${circle.id}/expenses/${moved.id}/move-to-personal`, alice.token, { version: moved.version });
        assert.equal((await automationJobs()).length, 0, "Returning to personal preserves source without notifying again");
        await run();
        const scheduled = await shortcut(`${root}/${circle.id}/expenses`, { ...circleBody, title: "Recurring Shortcut origin", recurrence: "daily",
            recurrence_interval: 1, recurrence_weekdays: [], occurred_at: new Date().toISOString() });
        await run();
        await api("/test/push/recurring", admin, { now: Date.parse(scheduled.recurrence_next) });
        assert.equal((await automationJobs()).length, 0, "Generated recurring copies do not masquerade as Shortcut calls");
        const copies = (await list("circle_expenses")).filter((row) => row.title === scheduled.title && row.id !== scheduled.id);
        assert.equal(copies.length, 1);
        assert.equal(copies[0].source, "shortcut", "Stored provenance stays unchanged");
        assert.equal(copies[0]._skip_automation_notification, undefined, "Internal metadata is never exported");
        await run();
    });
    await t.test("Explicit APNs tests use the relay without changing preferences or pending activity", async () => {
        const current = (await list("push_devices")).find((device) => device.user === alice.id);
        assert.ok(current);
        const path = `/api/expenditure/push/devices/${current.installation}/test`;
        const body = () => ({ token: current.token, environment: current.environment, server: base, request_id: randomUUID() });
        const reset = () => api(`/test/push/reset-cooldown/${alice.id}`, admin, {});
        await api(`/api/expenditure/push/devices/${current.installation}`, alice.token,
            { circle_expenses: false, circle_invitations: false, repayments: false, shortcut_expenses: false, api_expenses: false }, "PATCH", 204);
        const beforeDevices = await list("push_devices"), beforeJobs = await list("push_deliveries");
        const beforeRequests = deliveries.length;
        await api(path, null, body(), "POST", 401);
        await api(path, bob.token, body(), "POST", 403);
        await api(path, alice.token, { ...body(), user: bob.id }, "POST", 400);
        await api(path, alice.token, { ...body(), token: "invalid" }, "POST", 400);
        await api(path, alice.token, { ...body(), request_id: "not-a-uuid" }, "POST", 400);
        await api(path, alice.token, { ...body(), environment: "wrong" }, "POST", 400);
        assert.equal(deliveries.length, beforeRequests, "Rejected callers/input never reach the relay");
        responseMode = "sent";
        const request = body();
        const accepted = await api(path, alice.token, request);
        assert.deepEqual(accepted, { status: "accepted", request_id: request.request_id });
        const sent = deliveries.at(-1);
        assert.equal(sent.token, current.token);
        assert.equal(sent.environment, current.environment);
        assert.deepEqual(sent.payload, { type: "apns_test", test_id: request.request_id, user: alice.id, server: base,
            aps: { alert: { title: "Expenditure", body: "Your APNs test notification has arrived." }, sound: "default" } });
        assert.match(sent.id, /^[a-z0-9]{15}$/);
        await api(path, alice.token, body(), "POST", 429);
        assert.deepEqual(await list("push_devices"), beforeDevices, "Explicit tests do not save or enable choices");
        assert.deepEqual(await list("push_deliveries"), beforeJobs, "Tests never enter or consume the activity outbox");
        await reset();
        responseMode = "invalid";
        const rejected = await api(path, alice.token, body(), "POST", 400);
        assert.match(rejected.message, /Apple rejected/);
        assert.deepEqual(await list("push_devices"), beforeDevices, "Test rejection never removes an existing registration");
        await reset();
        responseMode = "retry";
        assert.match((await api(path, alice.token, body(), "POST", 503)).message, /Apple did not accept/);
        await reset();
        responseStatus = 401;
        assert.match((await api(path, alice.token, body(), "POST", 503)).message, /relay rejected/);
        responseStatus = 200;
        await reset();
        responseMode = "sent";
        responseDelay = 100;
        const simultaneous = await Promise.all([body(), body()].map(async (data) => {
            const response = await fetch(base + path, { method: "POST", headers: { Authorization: alice.token, "Content-Type": "application/json" }, body: JSON.stringify(data) });
            return response.status;
        }));
        assert.deepEqual(simultaneous.sort(), [200, 429], "Concurrent requests allow only one relay send");
        responseDelay = 0;
        await reset();
        const withoutRegistration = await api(`/api/expenditure/push/devices/${randomUUID()}/test`, alice.token,
            { ...body(), token: "f0".repeat(32) });
        assert.equal(withoutRegistration.status, "accepted", "An all-off unregistered iPhone can run an explicit test");
        assert.deepEqual(await list("push_devices"), beforeDevices);
        assert.deepEqual(await list("push_deliveries"), beforeJobs);
    });
});
