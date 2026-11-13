import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import timezoneCatalog from "../pocketbase/pb_hooks/timezones.json" with { type: "json" };

test(
    "Income, recurring transactions and custom schedules",
    { timeout: 60000 },
    async (t) => {
        const binary = process.env.POCKETBASE_BINARY;
        assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
        const directory = await mkdtemp(join(tmpdir(), "expenditure-circles-"));
        const listener = createServer();
        await new Promise((done) => listener.listen(0, "127.0.0.1", done));
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const hooks = join(directory, "hooks");
        await cp(resolve("pocketbase/pb_hooks"), hooks, { recursive: true });
        await writeFile(join(hooks, "test.pb.js"), `routerAdd("POST", "/api/test/recurrence", (e) => {
            require(__hooks + "/recurrence.js").run(e.app, e.requestInfo().body.now);
            return e.json(200, {});
        }, $apis.requireAuth("_superusers"));
        routerAdd("POST", "/api/test/next", (e) => {
            const data = e.requestInfo().body;
            const lib = require(__hooks + "/recurrence.js");
            return e.json(200, { next: data.now ? lib.firstFuture(data.previous, data.frequency, data.anchor, data.timezone, data.now, data.interval, data.day, data.weekdays, data.month) : lib.nextDate(data.previous, data.frequency, data.anchor, data.timezone, data.interval, data.day, data.weekdays, data.month) });
        }, $apis.requireAuth("_superusers"));
        routerAdd("GET", "/api/test/timezones", (e) => e.json(200, {
            items: require(__hooks + "/timezones.json").map((zone) => ({
                timezone: zone,
                offset: new DateTime("2026-01-15T12:00:00Z").time().in(new Timezone(zone)).format("-07:00"),
            })),
        }), $apis.requireAuth("_superusers"));`);
        const flags = [
            `--dir=${directory}`,
            `--hooksDir=${hooks}`,
            `--migrationsDir=${resolve("pocketbase/pb_migrations")}`,
        ];
        const password = randomBytes(24).toString("hex");
        const setup = spawnSync(
            binary,
            ["superuser", "upsert", "admin@example.com", password, ...flags],
            { encoding: "utf8" },
        );
        assert.equal(setup.status, 0, setup.stdout + setup.stderr);
        const server = spawn(
            binary,
            [
                "serve",
                "--automigrate=false",
                "--hooksWatch=false",
                `--http=127.0.0.1:${port}`,
                ...flags,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        let logs = "";
        server.stdout.on("data", (c) => {
            logs += c;
        });
        server.stderr.on("data", (c) => {
            logs += c;
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
        async function api(
            path,
            token,
            body,
            method = body === undefined ? "GET" : "POST",
            expected = 200,
        ) {
            ({ path, body } = await resolveCategoryFixture(base, path, body, token));
            const response = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { Authorization: token } : {}),
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const content = await response.text();
            const data = content ? JSON.parse(content) : null;
            assert.equal(
                response.status,
                expected,
                JSON.stringify({ path, data }) + (response.status >= 500 ? logs : ""),
            );
            return data;
        }

        for (let i = 0; i < 100; i++) {
            try {
                if ((await fetch(base + "/api/health")).ok) break;
            } catch {}

            if (i === 99) assert.fail(logs);
            await new Promise((done) => setTimeout(done, 25));
        }

        const admin = (
            await api("/api/collections/_superusers/auth-with-password", null, {
                identity: "admin@example.com",
                password,
            })
        ).token;
        async function user(name, verified = true) {
            const record = await api("/api/collections/users/records", admin, {
                email: `${name}@example.com`,
                name,
                verified,
                password,
                passwordConfirm: password,
            });
            const auth = await api("/api/collections/users/auth-with-password", null, {
                identity: `${name}@example.com`,
                password,
            });
            return { ...record, token: auth.token };
        }

        const alice = await user("Alice"), bob = await user("Bob"), outside = await user("Outside");
        const personal = "/api/collections/expenses/records";
        const aliceConfig = await api("/api/expenditure/config", alice.token);
        const input = { user: alice.id, merchant: "Salary", amount: 12345, currency: "SGD", category: "Other", occurred_at: "2026-10-27T04:00:00Z", kind: "income", recurrence: "" };
        await t.test("income is isolated, remains positive and does not consume a spending budget", async () => {
            const income = await api(personal, alice.token, input);
            assert.equal(income.kind, "income");
            await api(`${personal}/${income.id}`, outside.token, undefined, "GET", 404);
            await api(personal, alice.token, { ...input, amount: -100 }, "POST", 400);
            await api(personal, alice.token, { ...input, recurrence: "unknown" }, "POST", 400);
            await api(personal, alice.token, { ...input, kind: "invalid" }, "POST", 400);
            const query = new URLSearchParams({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", previous: "2026-09-01T00:00:00Z", currency: "all" });
            const overview = await api(`/api/expenditure/overview?${query}`, alice.token);
            assert.equal(overview.income, 12345);
            assert.equal(overview.total, 0);
            assert.equal(overview.count, 0);
            assert.deepEqual(overview.categories, []);
        });
        await t.test("default login tab is persisted and constrained to known tabs", async () => {
            assert.equal(aliceConfig.preferences.default_tab, "Overview");
            const path = `/api/collections/preferences/records/${aliceConfig.preferences.id}`;
            await api(path, alice.token, { default_tab: "Circles" }, "PATCH");
            assert.equal((await api("/api/expenditure/config", alice.token)).preferences.default_tab, "Circles");
            await api(path, alice.token, { default_tab: "unknown" }, "PATCH", 400);
            await api(path, alice.token, { default_tab: "API keys" }, "PATCH", 400);
            await api(path, outside.token, { default_tab: "Overview" }, "PATCH", 404);
        });
        const root = "/api/expenditure/circles";
        await t.test("expanded timezone choices are accepted, persisted and available to the scheduler", async () => {
            const schema = await api("/api/collections/preferences", admin);
            assert.deepEqual(schema.fields.find((field) => field.name === "timezone").values, timezoneCatalog);
            const supported = await api("/api/test/timezones", admin);
            assert.deepEqual(supported.items.map((item) => item.timezone), timezoneCatalog);
            assert.ok(supported.items.every((item) => /^[+-]\d{2}:\d{2}$/.test(item.offset)));
            const path = `/api/collections/preferences/records/${aliceConfig.preferences.id}`;
            for (const timezone of ["Asia/Tokyo", "Asia/Katmandu", "Australia/Eucla", "Pacific/Chatham", "America/St_Johns"]) {
                await api(path, alice.token, { timezone }, "PATCH");
                assert.equal((await api("/api/expenditure/config", alice.token)).preferences.timezone, timezone);
            }

            const next = await api("/api/test/next", admin, { previous: "2026-10-27T04:00:00Z", frequency: "daily", anchor: "2026-10-27T09:45:00", timezone: "Asia/Katmandu" });
            assert.equal(Date.parse(next.next), Date.parse("2026-10-28T04:00:00Z"));
            await api(path, alice.token, { timezone: "Not/A_Timezone" }, "PATCH", 400);
            await api(path, outside.token, { timezone: "Asia/Tokyo" }, "PATCH", 404);
            await api(path, alice.token, { timezone: "Asia/Singapore" }, "PATCH");
        });
        await t.test("time format is persisted per user, defaults to 24h and rejects unsupported values", async () => {
            const before = await api("/api/expenditure/config", alice.token);
            assert.equal(before.preferences.time_format, "24h");
            const path = `/api/collections/preferences/records/${before.preferences.id}`;
            await api(path, alice.token, { time_format: "12h" }, "PATCH");
            let after = await api("/api/expenditure/config", alice.token);
            assert.equal(after.preferences.time_format, "12h");
            assert.equal(after.preferences.timezone, before.preferences.timezone);
            assert.equal(after.preferences.default_tab, before.preferences.default_tab);
            assert.equal((await api("/api/expenditure/config", bob.token)).preferences.time_format, "24h");
            await api(path, outside.token, { time_format: "24h" }, "PATCH", 404);
            for (const time_format of ["", "13h", "12", 12, null]) {
                const response = await fetch(base + path, {
                    method: "PATCH", headers: { Authorization: alice.token, "Content-Type": "application/json" },
                    body: JSON.stringify({ time_format }),
                });
                assert.equal(response.status, 400, `time_format=${JSON.stringify(time_format)}`);
            }

            after = await api("/api/expenditure/config", alice.token);
            assert.equal(after.preferences.time_format, "12h");
            await api(path, alice.token, { time_format: "24h" }, "PATCH");
            assert.equal((await api("/api/expenditure/config", alice.token)).preferences.time_format, "24h");
        });
        const circle = await api(root, alice.token, { name: "Shared income", icon: "users", currency: "SGD" }, "POST", 201);
        const me = (await api(`${root}/${circle.id}`, alice.token)).me;
        const invitation = await api(`${root}/${circle.id}/invitations`, alice.token, { email: bob.email }, "POST", 201);
        const other = (await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, bob.token, {})).member;
        const shared = { title: "Refund", kind: "income", recurrence: "", amount: 101, currency: "SGD", paid_by: me, split_mode: "even", shares: [{ member: me }, { member: other }], occurred_at: input.occurred_at };
        await t.test("Circle income reverses debts for equal, percentage and exact splits", async () => {
            for (const [split_mode, shares] of [
                ["even", shared.shares],
                ["percentage", [{ member: me, percentage_bp: 3000 }, { member: other, percentage_bp: 7000 }]],
                ["exact", [{ member: me, amount: 21 }, { member: other, amount: 80 }]],
            ]) {
                const income = await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, split_mode, shares }, "POST", 201);
                const detail = await api(`${root}/${circle.id}`, alice.token);
                const entitled = income.shares.find((share) => share.member === other).amount;
                assert.equal(detail.balances.find((row) => row.member === me).net, -entitled);
                assert.equal(detail.balances.find((row) => row.member === other).net, entitled);
                assert.equal(detail.totals[0].total, 0);
                assert.equal(detail.totals[0].income, 101);
                assert.equal(detail.suggestions[0].from_member, me);
                await api(`${root}/${circle.id}/settlements`, alice.token, { from_member: me, to_member: other, amount: entitled + 1, currency: "SGD" }, "POST", 400);
                await api(`${root}/${circle.id}/expenses/${income.id}`, bob.token, { ...shared, split_mode, shares, version: income.version }, "PATCH", 403);
                await api(`${root}/${circle.id}/expenses/${income.id}`, alice.token, { version: income.version }, "DELETE");
            }

            await api(`${root}/${circle.id}/expenses`, outside.token, shared, "POST", 404);
            await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, recurrence: "unknown" }, "POST", 400);
        });
        await t.test("calendar recurrence clamps month ends and keeps local times across DST", async () => {
            async function next(previous, frequency, anchor, timezone) {
                return (await api("/api/test/next", admin, { previous, frequency, anchor, timezone })).next;
            }

            assert.equal(await next("2027-01-31T01:00:00Z", "monthly", "2027-01-31T09:00:00", "Asia/Singapore"), "2027-02-28T01:00:00.000Z");
            assert.equal(await next("2027-02-28T01:00:00Z", "monthly", "2027-01-31T09:00:00", "Asia/Singapore"), "2027-03-31T01:00:00.000Z");
            assert.equal(await next("2028-02-29T01:00:00Z", "yearly", "2028-02-29T09:00:00", "Asia/Singapore"), "2029-02-28T01:00:00.000Z");
            assert.equal(await next("2027-03-13T14:00:00Z", "daily", "2027-03-13T09:00:00", "America/New_York"), "2027-03-14T13:00:00.000Z");
            assert.equal(await next("2027-11-06T13:00:00Z", "weekly", "2027-11-06T09:00:00", "America/New_York"), "2027-11-13T14:00:00.000Z");
            assert.equal(await next("2027-03-13T07:30:00Z", "daily", "2027-03-13T02:30:00", "America/New_York"), "2027-03-14T07:30:00.000Z");
            for (const [frequency, expected] of [["daily", "2026-10-28T01:00:00.000Z"], ["weekly", "2026-11-02T01:00:00.000Z"], ["monthly", "2026-10-31T01:00:00.000Z"], ["yearly", "2027-01-31T01:00:00.000Z"]]) {
                const result = await api("/api/test/next", admin, { previous: "2000-01-31T01:00:00Z", frequency, anchor: "2000-01-31T09:00:00", timezone: "Asia/Singapore", now: Date.parse("2026-10-27T04:00:00Z") });
                assert.equal(result.next, expected);
            }
        });
        await t.test("custom calendar intervals preserve phase, month days and DST wall-clock times", async () => {
            async function next(previous, frequency, anchor, timezone, interval, day = 0, now) {
                return (await api("/api/test/next", admin, { previous, frequency, anchor, timezone, interval, day, now })).next;
            }

            assert.equal(await next("2091-01-01T04:00:00Z", "daily", "2091-01-01T12:00:00", "Asia/Singapore", 3), "2091-01-04T04:00:00.000Z");
            assert.equal(await next("2027-03-07T14:00:00Z", "weekly", "2027-03-07T09:00:00", "America/New_York", 2), "2027-03-21T13:00:00.000Z");
            assert.equal(await next("2027-10-31T13:00:00Z", "weekly", "2027-10-31T09:00:00", "America/New_York", 2), "2027-11-14T14:00:00.000Z");
            assert.equal(await next("2027-01-31T01:00:00Z", "monthly", "2027-01-31T09:00:00", "Asia/Singapore", 3), "2027-04-30T01:00:00.000Z");
            assert.equal(await next("2027-04-30T01:00:00Z", "monthly", "2027-01-31T09:00:00", "Asia/Singapore", 3), "2027-07-31T01:00:00.000Z");
            assert.equal(await next("2028-02-29T01:00:00Z", "yearly", "2028-02-29T09:00:00", "Asia/Singapore", 4), "2032-02-29T01:00:00.000Z");
            assert.equal(await next("2028-01-31T01:00:00Z", "monthly", "2028-01-02T09:00:00", "Asia/Singapore", 1, -1), "2028-02-29T01:00:00.000Z");
            assert.equal(await next("2028-02-29T01:00:00Z", "monthly", "2028-01-02T09:00:00", "Asia/Singapore", 1, 31), "2028-03-31T01:00:00.000Z");
            assert.equal(await next("2027-02-14T07:30:00Z", "monthly", "2027-02-14T02:30:00", "America/New_York", 1, 14), "2027-03-14T07:30:00.000Z");
            assert.equal(await next("2027-03-14T07:30:00Z", "monthly", "2027-02-14T02:30:00", "America/New_York", 1, 14), "2027-04-14T06:30:00.000Z");
            const before = Date.parse("2026-10-27T04:00:00Z");
            assert.equal(await next("2091-01-01T04:00:00Z", "monthly", "2091-01-01T12:00:00", "Asia/Singapore", 2, 15, before), "2091-01-15T04:00:00.000Z");
            assert.equal(await next("2091-01-20T04:00:00Z", "monthly", "2091-01-20T12:00:00", "Asia/Singapore", 2, 15, before), "2091-03-15T04:00:00.000Z");
            assert.equal(await next("2000-01-01T04:00:00Z", "monthly", "2000-01-01T12:00:00", "Asia/Singapore", 3, -1, Date.parse("2026-10-31T04:00:00Z")), "2027-01-31T04:00:00.000Z");
            assert.equal(await next("2000-01-01T04:00:00Z", "daily", "2000-01-01T12:00:00", "Asia/Singapore", 3, 0, Date.parse("2000-01-04T04:00:00Z")), "2000-01-07T04:00:00.000Z");
        });
        await t.test("unchanged picker dates preserve personal and Circle schedule cursors after a timezone change", async () => {
            const account = await user("TimestampPreservation");
            const config = await api("/api/expenditure/config", account.token);
            const originalTime = "2091-01-01T04:00:45.123Z";
            const seed = await api(personal, account.token, { ...input, user: account.id, merchant: "Precise schedule", recurrence: "monthly", recurrence_interval: 1, occurred_at: originalTime });
            const group = await api(root, account.token, { name: "Precise Circle", currency: "SGD" }, "POST", 201);
            const path = `${root}/${group.id}`;
            const member = (await api(path, account.token)).me;
            const fields = { ...shared, paid_by: member, shares: [{ member }], recurrence: "monthly", recurrence_interval: 1, occurred_at: originalTime };
            const circleSeed = await api(`${path}/expenses`, account.token, fields, "POST", 201);
            await api(`/api/collections/preferences/records/${config.preferences.id}`, account.token, { timezone: "UTC", time_format: "12h" }, "PATCH");
            const originalSchedule = (row) => Object.fromEntries(["occurred_at", "recurrence_anchor", "recurrence_next", "recurrence_timezone"].map((key) => [key, row[key]]));
            const preserved = (row) => new Date(row.occurred_at.replace(" ", "T")).toISOString();
            const edited = await api(`${personal}/${seed.id}`, account.token, { notes: "Updated note", occurred_at: preserved(seed) }, "PATCH");
            const sharedEdit = await api(`${path}/expenses/${circleSeed.id}`, account.token, { ...fields, notes: "Updated shared note", occurred_at: preserved(circleSeed), version: circleSeed.version }, "PATCH");
            assert.deepEqual(originalSchedule(edited), originalSchedule(seed));
            assert.deepEqual(originalSchedule(sharedEdit), originalSchedule(circleSeed));
            assert.deepEqual(originalSchedule(await api(`${personal}/${seed.id}`, account.token)), originalSchedule(seed));
            const detail = await api(path, account.token);
            assert.deepEqual(originalSchedule(detail.expenses.items.find((row) => row.id === circleSeed.id)), originalSchedule(circleSeed));
        });
        await t.test("personal recurring income catches up fortnightly without duplicate income or budget spending", async () => {
            const account = await user("Schedules");
            await api("/api/expenditure/config", account.token);
            let seed = await api(personal, account.token, { ...input, user: account.id, merchant: "Fortnightly salary", recurrence: "weekly", recurrence_interval: 2, occurred_at: "2091-01-01T04:00:00Z" });
            assert.equal(seed.recurrence_interval, 2);
            assert.equal(seed.recurrence_next, "2091-01-15T04:00:00.000Z");
            const run = () => api("/api/test/recurrence", admin, { now: Date.parse("2091-01-31T04:00:00Z") });
            await Promise.all([run(), run()]);
            let rows = (await api(`${personal}?perPage=100`, account.token)).items;
            assert.equal(rows.length, 3);
            assert.equal(new Set(rows.map((row) => row.occurred_at)).size, 3);
            assert.ok(rows.every((row) => row.kind === "income" && row.amount === input.amount));
            assert.ok(rows.filter((row) => row.id !== seed.id).every((row) => row.recurrence === "" && row.recurrence_interval === 0 && row.recurrence_day === 0));
            seed = await api(`${personal}/${seed.id}`, account.token);
            assert.equal(seed.recurrence_next, "2091-02-12T04:00:00.000Z");
            const notesOnly = await api(`${personal}/${seed.id}`, account.token, { notes: "Future salary" }, "PATCH");
            assert.equal(notesOnly.recurrence_next, seed.recurrence_next);
            assert.equal(notesOnly.recurrence_anchor, seed.recurrence_anchor);
            const query = new URLSearchParams({ from: "2091-01-01T00:00:00Z", to: "2091-02-01T00:00:00Z", previous: "2090-12-01T00:00:00Z", currency: "all" });
            const overview = await api(`/api/expenditure/overview?${query}`, account.token);
            assert.equal(overview.income, input.amount * 3);
            assert.equal(overview.total, 0);
            await api(`${personal}/${seed.id}`, outside.token, { recurrence_interval: 3 }, "PATCH", 404);
            // Editing affects the original and future entries, never generated history.
            const changed = await api(`${personal}/${seed.id}`, account.token, { recurrence: "monthly", recurrence_interval: 2, recurrence_day: 15, occurred_at: "2092-01-01T04:00:00Z" }, "PATCH");
            assert.equal(changed.recurrence_next, "2092-01-15T04:00:00.000Z");
            rows = (await api(`${personal}?perPage=100`, account.token)).items.filter((row) => row.id !== seed.id);
            assert.ok(rows.every((row) => row.occurred_at.startsWith("2091-01") && row.kind === "income" && row.amount === input.amount));
            const stopped = await api(`${personal}/${seed.id}`, account.token, { recurrence: "" }, "PATCH");
            assert.equal(stopped.recurrence_interval, 0);
            assert.equal(stopped.recurrence_day, 0);
            assert.equal(stopped.recurrence_next, "");
            await run();
            assert.equal((await api(`${personal}?perPage=100`, account.token)).items.length, 3);
        });
        await t.test("Circle recurring income preserves shares, reversed balances and custom cadence", async () => {
            const group = await api(root, alice.token, { name: "Recurring income", currency: "SGD" }, "POST", 201);
            const path = `${root}/${group.id}`;
            const recipient = (await api(path, alice.token)).me;
            const invitation = await api(`${path}/invitations`, alice.token, { email: bob.email }, "POST", 201);
            const entitled = (await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, bob.token, {})).member;
            const fields = { ...shared, recurrence: "weekly", recurrence_interval: 2, paid_by: recipient, shares: [{ member: recipient }, { member: entitled }], occurred_at: "2091-01-01T04:00:00Z" };
            const seed = await api(`${path}/expenses`, alice.token, fields, "POST", 201);
            await Promise.all([1, 2].map(() => api("/api/test/recurrence", admin, { now: Date.parse("2091-01-31T04:00:00Z") })));
            const detail = await api(path, alice.token);
            assert.equal(detail.expenses.totalItems, 3);
            assert.equal(detail.recurring.length, 1);
            assert.equal(detail.recurring[0].recurrence_next, "2091-02-12T04:00:00.000Z");
            assert.ok(detail.expenses.items.every((row) => row.kind === "income" && row.amount === seed.amount && JSON.stringify(row.shares) === JSON.stringify(seed.shares)));
            assert.ok(detail.expenses.items.filter((row) => row.id !== seed.id).every((row) => row.recurrence_interval === 0 && row.recurrence_day === 0 && row.created_by === recipient));
            assert.equal(detail.balances.find((row) => row.member === recipient).net, -seed.shares.find((row) => row.member === entitled).amount * 3);
            assert.equal(detail.totals[0].income, 303);
            assert.equal(detail.totals[0].total, 0);
            const current = detail.recurring[0];
            await api(`${path}/expenses/${seed.id}`, bob.token, { ...fields, version: current.version }, "PATCH", 403);
            await api(`${path}/expenses/${seed.id}`, alice.token, { ...fields, recurrence: "", version: current.version }, "PATCH");
            await api("/api/test/recurrence", admin, { now: Date.parse("2091-03-31T04:00:00Z") });
            assert.equal((await api(path, alice.token)).expenses.totalItems, 3);
        });
        await t.test("chosen monthly dates, last-day income and every-N-day expenses generate their exact schedule", async () => {
            const account = await user("CalendarSchedules");
            await api("/api/expenditure/config", account.token);
            const create = (merchant, fields) => api(personal, account.token, { ...input, user: account.id, merchant, occurred_at: "2091-01-01T04:00:00Z", ...fields });
            const dated = await create("Every other month", { kind: "expense", recurrence: "monthly", recurrence_interval: 2, recurrence_day: 31 });
            const last = await create("Last-day income", { recurrence: "monthly", recurrence_day: -1 });
            const daily = await create("Every third day", { kind: "expense", recurrence: "daily", recurrence_interval: 3 });
            assert.equal(dated.recurrence_next, "2091-01-31T04:00:00.000Z");
            assert.equal(last.recurrence_next, "2091-01-31T04:00:00.000Z");
            await api("/api/test/recurrence", admin, { now: Date.parse("2091-01-10T04:00:00Z") });
            const thirdDayRows = (await api(`${personal}?perPage=100`, account.token)).items.filter((row) => row.merchant === daily.merchant);
            assert.deepEqual(thirdDayRows.map((row) => row.occurred_at.slice(0, 10)).sort(), ["2091-01-01", "2091-01-04", "2091-01-07", "2091-01-10"]);
            await api(`${personal}/${daily.id}`, account.token, { recurrence: "" }, "PATCH");
            await api("/api/test/recurrence", admin, { now: Date.parse("2091-03-31T04:00:00Z") });
            const rows = (await api(`${personal}?perPage=100`, account.token)).items;
            assert.deepEqual(rows.filter((row) => row.merchant === dated.merchant).map((row) => row.occurred_at.slice(0, 10)).sort(), ["2091-01-01", "2091-01-31", "2091-03-31"]);
            assert.deepEqual(rows.filter((row) => row.merchant === last.merchant).map((row) => row.occurred_at.slice(0, 10)).sort(), ["2091-01-01", "2091-01-31", "2091-02-28", "2091-03-31"]);
            for (const seed of [dated, last]) await api(`${personal}/${seed.id}`, account.token, { recurrence: "" }, "PATCH");
        });
        await t.test("weekday selections keep alternating calendar weeks, cross year boundaries and retain DST time", async () => {
            const next = async (data) => (await api("/api/test/next", admin, data)).next;
            const base = { frequency: "weekly", interval: 2, weekdays: [1, 3, 5], timezone: "Asia/Singapore", anchor: "2091-01-01T12:00:00" };
            assert.equal(await next({ ...base, previous: "2091-01-01T04:00:00Z" }), "2091-01-03T04:00:00.000Z");
            assert.equal(await next({ ...base, previous: "2091-01-05T04:00:00Z" }), "2091-01-15T04:00:00.000Z");
            assert.equal(await next({ ...base, previous: "2091-01-01T04:00:00Z", now: Date.parse("2091-01-10T04:00:00Z") }), "2091-01-15T04:00:00.000Z");
            assert.equal(await next({ ...base, anchor: "2026-12-28T12:00:00", previous: "2027-01-01T04:00:00Z" }), "2027-01-11T04:00:00.000Z");
            assert.equal(await next({ frequency: "weekly", weekdays: [1, 7], interval: 1, timezone: "America/New_York", anchor: "2027-03-07T02:30:00", previous: "2027-03-08T07:30:00Z" }), "2027-03-14T07:30:00.000Z");
            assert.equal(await next({ frequency: "weekly", weekdays: [1, 7], interval: 1, timezone: "America/New_York", anchor: "2027-03-07T02:30:00", previous: "2027-03-14T07:30:00Z" }), "2027-03-15T06:30:00.000Z");
            assert.equal(await next({ frequency: "weekly", weekdays: [1, 7], interval: 1, timezone: "America/New_York", anchor: "2027-10-31T09:00:00", previous: "2027-11-01T13:00:00Z" }), "2027-11-07T14:00:00.000Z");
        });
        await t.test("yearly dates can fall later in the entry year and recover leap days after clamping", async () => {
            const next = async (data) => (await api("/api/test/next", admin, data)).next;
            const base = { frequency: "yearly", interval: 2, month: 12, day: 25, timezone: "Asia/Singapore", anchor: "2091-01-01T12:00:00", previous: "2091-01-01T04:00:00Z" };
            assert.equal(await next({ ...base, now: Date.parse(base.previous) }), "2091-12-25T04:00:00.000Z");
            assert.equal(await next({ ...base, previous: "2091-12-25T04:00:00Z" }), "2093-12-25T04:00:00.000Z");
            assert.equal(await next({ ...base, now: Date.parse("2092-01-01T04:00:00Z") }), "2093-12-25T04:00:00.000Z");
            const leap = { ...base, interval: 1, month: 2, day: 29 };
            assert.equal(await next({ ...leap, previous: "2091-02-28T04:00:00Z" }), "2092-02-29T04:00:00.000Z");
            assert.equal(await next({ ...leap, previous: "2092-02-29T04:00:00Z" }), "2093-02-28T04:00:00.000Z");
            assert.equal(await next({ ...leap, day: -1, previous: "2095-02-28T04:00:00Z" }), "2096-02-29T04:00:00.000Z");
        });
        await t.test("personal and Circle schedules persist weekday/yearly choices and catch up exactly once", async () => {
            const account = await user("WeekdaySchedules");
            await api("/api/expenditure/config", account.token);
            const seed = await api(personal, account.token, { ...input, user: account.id, recurrence: "weekly", recurrence_interval: 2, recurrence_weekdays: [5, 1, 3], occurred_at: "2091-01-01T04:00:00Z" });
            assert.deepEqual(seed.recurrence_weekdays, [1, 3, 5]);
            assert.equal(seed.recurrence_next, "2091-01-03T04:00:00.000Z");
            await Promise.all([1, 2].map(() => api("/api/test/recurrence", admin, { now: Date.parse("2091-01-17T04:00:00Z") })));
            const rows = (await api(`${personal}?perPage=100`, account.token)).items;
            assert.deepEqual(rows.map((row) => row.occurred_at.slice(0, 10)).sort(), ["2091-01-01", "2091-01-03", "2091-01-05", "2091-01-15", "2091-01-17"]);
            assert.ok(rows.filter((row) => row.id !== seed.id).every((row) => row.recurrence_month === 0 && row.recurrence_weekdays.length === 0));
            const current = await api(`${personal}/${seed.id}`, account.token);
            const note = await api(`${personal}/${seed.id}`, account.token, { notes: "Keep cursor" }, "PATCH");
            assert.equal(note.recurrence_next, current.recurrence_next);
            const changed = await api(`${personal}/${seed.id}`, account.token, { recurrence_weekdays: [2, 4] }, "PATCH");
            assert.equal(changed.recurrence_next, "2091-01-02T04:00:00.000Z");
            await api(`${personal}/${seed.id}`, outside.token, { recurrence_weekdays: [6] }, "PATCH", 404);
            const stopped = await api(`${personal}/${seed.id}`, account.token, { recurrence: "" }, "PATCH");
            assert.deepEqual(stopped.recurrence_weekdays, []);
            const group = await api(root, alice.token, { name: "Yearly dates", currency: "SGD" }, "POST", 201);
            const path = `${root}/${group.id}`;
            const member = (await api(path, alice.token)).me;
            const fields = { ...shared, recurrence: "yearly", recurrence_interval: 2, recurrence_month: 12, recurrence_day: 25, paid_by: member, shares: [{ member }], occurred_at: "2091-01-01T04:00:00Z" };
            const yearly = await api(`${path}/expenses`, alice.token, fields, "POST", 201);
            assert.equal(yearly.recurrence_month, 12);
            assert.equal(yearly.recurrence_next, "2091-12-25T04:00:00.000Z");
            await Promise.all([1, 2].map(() => api("/api/test/recurrence", admin, { now: Date.parse("2093-12-25T04:00:00Z") })));
            const detail = await api(path, alice.token);
            assert.deepEqual(detail.expenses.items.map((row) => row.occurred_at.slice(0, 10)).sort(), ["2091-01-01", "2091-12-25", "2093-12-25"]);
            assert.equal(detail.recurring[0].recurrence_next, "2095-12-25T04:00:00.000Z");
            assert.ok(detail.expenses.items.filter((row) => row.id !== yearly.id).every((row) => row.recurrence_month === 0 && row.recurrence_weekdays.length === 0));
            await api(`${path}/expenses/${yearly.id}`, alice.token, { ...fields, recurrence_month: 11, version: yearly.version }, "PATCH", 409);
            await api(`${path}/expenses/${yearly.id}`, alice.token, { ...fields, recurrence: "", version: detail.recurring[0].version }, "PATCH");
        });
        await t.test("custom schedules reject invalid intervals and calendar selections on both ledgers", async () => {
            for (const fields of [
                { recurrence_interval: -1 }, { recurrence_interval: 366 }, { recurrence_interval: 1.5 },
                { recurrence_day: -2 }, { recurrence_day: 32 }, { recurrence_day: 1.5 },
                { recurrence: "weekly", recurrence_day: 15 },
                { recurrence_month: -1 }, { recurrence_month: 13 }, { recurrence_month: 1.5 },
                { recurrence: "monthly", recurrence_month: 2 },
                { recurrence: "yearly", recurrence_weekdays: [1] },
                ...[null, {}, "Monday", [0], [8], [1.5], ["1"], [1, 1], [1, 2, 3, 4, 5, 6, 7, 1]].map((recurrence_weekdays) => ({ recurrence: "weekly", recurrence_weekdays })),
            ]) {
                await api(personal, alice.token, { ...input, recurrence: "monthly", ...fields }, "POST", 400);
                await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, recurrence: "monthly", ...fields }, "POST", 400);
            }

            // Custom JSON routes require number values. Native collection form
            // requests use PocketBase's number-field normalization first.
            for (const fields of [{ recurrence_interval: "2" }, { recurrence_interval: null }, { recurrence_interval: true }, { recurrence_day: "15" }, { recurrence_day: null }])
                await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, recurrence: "monthly", ...fields }, "POST", 400);
            const normalized = await api(personal, alice.token, { ...input, recurrence: "weekly", recurrence_interval: "2", occurred_at: "2092-01-01T04:00:00Z" });
            assert.equal(normalized.recurrence_interval, 2);
            assert.equal(normalized.recurrence_next, "2092-01-15T04:00:00.000Z");
            await api(`${personal}/${normalized.id}`, alice.token, undefined, "DELETE", 204);
        });
        let recurring, recurringCircle;
        const now = Date.parse("2090-01-04T04:00:00Z");
        await t.test("recurring creation catches up once, survives concurrent runs and preserves provenance", async () => {
            recurring = await api(personal, alice.token, { ...input, kind: "expense", recurrence: "daily", merchant: "Recurring", occurred_at: "2090-01-01T04:00:00Z", recurrence_next: "2000-01-01T00:00:00Z", recurrence_timezone: "UTC" });
            assert.equal(recurring.recurrence_next, "2090-01-02T04:00:00.000Z");
            assert.equal(recurring.recurrence_timezone, "Asia/Singapore");
            recurringCircle = await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, kind: "expense", recurrence: "daily", occurred_at: "2090-01-01T04:00:00Z" }, "POST", 201);
            await Promise.all([api("/api/test/recurrence", admin, { now }), api("/api/test/recurrence", admin, { now })]);
            const rows = (await api(`${personal}?perPage=100`, alice.token)).items.filter((row) => row.merchant === "Recurring");
            assert.equal(rows.length, 4);
            assert.equal(new Set(rows.map((row) => row.occurred_at)).size, 4);
            assert.ok(rows.every((row) => row.amount === 12345 && row.source === "manual"));
            assert.equal(rows.filter((row) => row.recurrence).length, 1);
            const detail = await api(`${root}/${circle.id}`, alice.token);
            assert.equal(detail.expenses.totalItems, 4);
            assert.equal(detail.recurring.length, 1);
            assert.equal(detail.balances.reduce((sum, row) => sum + row.net, 0), 0);
            assert.equal(detail.balances.find((row) => row.member === me).net, recurringCircle.shares.find((share) => share.member === other).amount * 4);
            await api(`${root}/${circle.id}/expenses/${recurringCircle.id}`, alice.token, { ...shared, kind: "expense", recurrence: "daily", version: recurringCircle.version, occurred_at: recurringCircle.occurred_at }, "PATCH", 409);
        });
        await t.test("stopping recurrence preserves generated entries and rejects cross-account edits", async () => {
            await api(`${personal}/${recurring.id}`, outside.token, { recurrence: "" }, "PATCH", 404);
            await api(`${personal}/${recurring.id}`, alice.token, { recurrence: "" }, "PATCH");
            const detail = await api(`${root}/${circle.id}`, alice.token);
            const current = detail.recurring[0];
            await api(`${root}/${circle.id}/expenses/${current.id}`, alice.token, { ...shared, kind: "expense", recurrence: "", occurred_at: new Date(current.occurred_at.replace(" ", "T")).toISOString(), version: current.version }, "PATCH");
            await api("/api/test/recurrence", admin, { now: now + 86400000 });
            assert.equal((await api(`${root}/${circle.id}`, alice.token)).expenses.totalItems, 4);
            assert.equal((await api(`${personal}?perPage=100`, alice.token)).items.filter((row) => row.merchant === "Recurring").length, 4);
        });
        await t.test("recurring Circle writes pause when a participant is no longer active", async () => {
            const seed = await api(`${root}/${circle.id}/expenses`, alice.token, { ...shared, kind: "expense", recurrence: "daily", occurred_at: "2090-01-01T04:00:00Z" }, "POST", 201);
            await api(`/api/collections/circle_members/records/${other}`, admin, { active: false }, "PATCH");
            await api("/api/test/recurrence", admin, { now });
            const detail = await api(`${root}/${circle.id}`, alice.token);
            assert.equal(detail.expenses.totalItems, 5);
            assert.ok(detail.recurring.find((row) => row.id === seed.id).recurrence_error);
            await api("/api/test/recurrence", admin, { now });
            assert.equal((await api(`${root}/${circle.id}`, alice.token)).expenses.totalItems, 5);
        });
    },
);
