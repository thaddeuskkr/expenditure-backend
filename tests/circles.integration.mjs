import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test(
    "Circles membership, financial splits, settlements and owner controls",
    { timeout: 90000 },
    async (t) => {
        const binary = process.env.POCKETBASE_BINARY;
        assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
        const directory = await mkdtemp(join(tmpdir(), "expenditure-circles-"));
        const listener = createServer();
        await new Promise((done) => listener.listen(0, "127.0.0.1", done));
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const flags = [
            `--dir=${directory}`,
            `--hooksDir=${resolve("pocketbase/pb_hooks")}`,
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

        const alice = await user("Alice"),
            bob = await user("Bob"),
            carol = await user("Carol"),
            outsider = await user("Outside"),
            unverified = await user("Unverified", false);
        const root = "/api/expenditure/circles";
        let circle, aliceMember, bobMember, carolMember, expense, settlement;
        const date = "2026-10-27T12:00:00+08:00";
        await t.test(
            "collections are locked and only authenticated users can create circles",
            async () => {
                await api(root, null, undefined, "GET", 401);
                for (const name of [
                    "circles",
                    "circle_members",
                    "circle_invitations",
                    "circle_expenses",
                    "circle_settlements",
                ]) {
                    await api(
                        `/api/collections/${name}/records`,
                        alice.token,
                        undefined,
                        "GET",
                        403,
                    );
                    await api(`/api/collections/${name}/records`, alice.token, {}, "POST", 403);
                }

                circle = await api(
                    root,
                    alice.token,
                    { name: "Japan trip", icon: "plane", currency: "SGD" },
                    "POST",
                    201,
                );
                const detail = await api(`${root}/${circle.id}`, alice.token);
                aliceMember = detail.me;
                assert.equal(detail.circle.is_owner, true);
                assert.equal(detail.members.length, 1);
                assert.equal(detail.members[0].user, alice.id);
                assert.equal(detail.members[0].expand.user.id, alice.id);
                assert.equal(detail.members[0].expand.user.email, undefined);
                assert.equal(detail.members[0].expand.user.password, undefined);
                await api(`${root}/${circle.id}`, outsider.token, undefined, "GET", 404);
            },
        );
        await t.test(
            "owner invitations require the matching verified recipient and can be revoked or expire",
            async () => {
                const invitation = await api(
                    `${root}/${circle.id}/invitations`,
                    alice.token,
                    { email: "bob@example.com" },
                    "POST",
                    201,
                );
                await api(
                    `/api/expenditure/circle-invitations/${invitation.id}`,
                    outsider.token,
                    undefined,
                    "GET",
                    403,
                );
                await api(
                    `/api/expenditure/circle-invitations/${invitation.id}/accept`,
                    outsider.token,
                    {},
                    "POST",
                    403,
                );
                const incoming = (await api(root, bob.token)).invitations;
                assert.equal(incoming.length, 1);
                assert.equal(incoming[0].circle, circle.id);
                assert.equal(incoming[0].expand.circle.name, circle.name);
                const preview = await api(`/api/expenditure/circle-invitations/${invitation.id}`, bob.token);
                assert.equal(preview.circle, circle.id);
                assert.equal(preview.expand.circle.id, circle.id);
                bobMember = (
                    await api(
                        `/api/expenditure/circle-invitations/${invitation.id}/accept`,
                        bob.token,
                        {},
                    )
                ).member;
                await api(
                    `/api/expenditure/circle-invitations/${invitation.id}/accept`,
                    bob.token,
                    {},
                    "POST",
                    400,
                );
                await api(
                    `${root}/${circle.id}/invitations`,
                    bob.token,
                    { email: "carol@example.com" },
                    "POST",
                    403,
                );
                const carolInvite = await api(
                    `${root}/${circle.id}/invitations`,
                    alice.token,
                    { email: "carol@example.com" },
                    "POST",
                    201,
                );
                carolMember = (
                    await api(
                        `/api/expenditure/circle-invitations/${carolInvite.id}/accept`,
                        carol.token,
                        {},
                    )
                ).member;
                const pending = await api(
                    `${root}/${circle.id}/invitations`,
                    alice.token,
                    { email: "unverified@example.com" },
                    "POST",
                    201,
                );
                await api(
                    `/api/expenditure/circle-invitations/${pending.id}/accept`,
                    unverified.token,
                    {},
                    "POST",
                    403,
                );
                await api(
                    `/api/expenditure/circle-invitations/${pending.id}`,
                    alice.token,
                    undefined,
                    "DELETE",
                );
                await api(
                    `/api/expenditure/circle-invitations/${pending.id}/accept`,
                    unverified.token,
                    {},
                    "POST",
                    403,
                );
                const expiring = await api(
                    `${root}/${circle.id}/invitations`,
                    alice.token,
                    { email: "outside@example.com" },
                    "POST",
                    201,
                );
                await api(
                    `/api/collections/circle_invitations/records/${expiring.id}`,
                    admin,
                    { expires_at: "2020-01-01T00:00:00Z" },
                    "PATCH",
                );
                await api(
                    `/api/expenditure/circle-invitations/${expiring.id}/accept`,
                    outsider.token,
                    {},
                    "POST",
                    400,
                );
                assert.ok(
                    (await api(`${root}/${circle.id}`, bob.token)).members.every(
                        (m) => !JSON.stringify(m).includes("@example.com"),
                    ),
                );
            },
        );
        await t.test(
            "equal, percentage and exact splits preserve integer totals and reject invalid allocations",
            async () => {
                const input = {
                    title: "Dinner",
                    amount: 1000,
                    currency: "SGD",
                    paid_by: aliceMember,
                    split_mode: "even",
                    shares: [
                        { member: aliceMember },
                        { member: bobMember },
                        { member: carolMember },
                    ],
                    occurred_at: date,
                };
                expense = await api(`${root}/${circle.id}/expenses`, bob.token, input, "POST", 201);
                assert.equal(
                    expense.shares.reduce((sum, row) => sum + row.amount, 0),
                    1000,
                );
                const outsidersCircle = await api(
                    root,
                    outsider.token,
                    { name: "Private", icon: "users", currency: "JPY" },
                    "POST",
                    201,
                );
                const outsiderMember = (await api(`${root}/${outsidersCircle.id}`, outsider.token))
                    .me;
                for (const change of [
                    { shares: [] },
                    { shares: [{ member: bobMember }, { member: bobMember }] },
                    { paid_by: outsiderMember },
                    { shares: [{ member: outsiderMember }] },
                    { currency: "ZZZ" },
                    { amount: 1.5 },
                    { amount_minor: 1000 },
                    { amount_cents: 1000 },
                    { card: "Visa" },
                    { split_mode: "exact", shares: [{ member: bobMember, value: "10.00" }] },
                    { split_mode: "exact", shares: [{ member: bobMember, amount: "1000" }] },
                    { split_mode: "even", shares: [{ member: bobMember, amount: 1000 }] },
                    { split_mode: "percentage", shares: [{ member: bobMember, percentage_bp: 10000.1 }] },
                    { split_mode: "percentage", shares: [{ member: bobMember, percentage_bp: 9900 }] },
                    { split_mode: "exact", shares: [{ member: bobMember, amount: 999 }] },
                    { notes: [] },
                    { occurred_at: "2026-02-30T10:00:00Z" },
                ])
                    await api(
                        `${root}/${circle.id}/expenses`,
                        bob.token,
                        { ...input, ...change },
                        "POST",
                        400,
                    );
                const percent = await api(
                    `${root}/${circle.id}/expenses`,
                    alice.token,
                    {
                        ...input,
                        title: "Taxi",
                        split_mode: "percentage",
                        shares: [
                            { member: bobMember, percentage_bp: 2500 },
                            { member: carolMember, percentage_bp: 7500 },
                        ],
                    },
                    "POST",
                    201,
                );
                assert.deepEqual(
                    percent.shares.map((row) => row.amount),
                    [250, 750],
                );
                const exact = await api(
                    `${root}/${circle.id}/expenses`,
                    alice.token,
                    {
                        ...input,
                        title: "Solo ticket",
                        currency: "KWD",
                        amount: 1234,
                        split_mode: "exact",
                        shares: [{ member: bobMember, amount: 1234 }],
                    },
                    "POST",
                    201,
                );
                assert.equal(exact.shares[0].amount, 1234);
                const detail = await api(`${root}/${circle.id}`, bob.token);
                assert.equal(
                    detail.balances
                        .filter((row) => row.currency === "SGD")
                        .reduce((sum, row) => sum + row.net, 0),
                    0,
                );
                assert.ok(
                    detail.suggestions.some(
                        (row) => row.currency === "KWD" && row.amount === 1234,
                    ),
                );
                await api(
                    `${root}/${circle.id}/expenses/${expense.id}`,
                    carol.token,
                    { ...input, version: expense.version },
                    "PATCH",
                    403,
                );
                expense = await api(
                    `${root}/${circle.id}/expenses/${expense.id}`,
                    bob.token,
                    { ...input, title: "Dinner edited", version: expense.version },
                    "PATCH",
                );
                await api(
                    `${root}/${circle.id}/expenses/${expense.id}`,
                    bob.token,
                    { ...input, version: 1 },
                    "PATCH",
                    409,
                );
                await api(
                    `${root}/${circle.id}/expenses/${expense.id}`,
                    outsider.token,
                    { version: expense.version },
                    "DELETE",
                    404,
                );
            },
        );
        await t.test(
            "settlements cannot overpay and removal requires balances settled in every currency",
            async () => {
                await api(
                    `${root}/${circle.id}/members/${bobMember}`,
                    alice.token,
                    undefined,
                    "DELETE",
                    400,
                );
                const detail = await api(`${root}/${circle.id}`, alice.token);
                const suggestion = detail.suggestions.find((row) => row.currency === "KWD");
                await api(
                    `${root}/${circle.id}/settlements`,
                    alice.token,
                    { ...suggestion, amount: 1235 },
                    "POST",
                    400,
                );
                await api(`${root}/${circle.id}/settlements`, carol.token, suggestion, "POST", 403);
                settlement = await api(
                    `${root}/${circle.id}/settlements`,
                    bob.token,
                    suggestion,
                    "POST",
                    201,
                );
                await api(
                    `${root}/${circle.id}/settlements/${settlement.id}`,
                    carol.token,
                    { version: 1 },
                    "DELETE",
                    403,
                );
                await api(
                    `${root}/${circle.id}/settlements/${settlement.id}`,
                    alice.token,
                    { version: 1 },
                    "DELETE",
                );
                const fresh = await api(`${root}/${circle.id}`, alice.token);
                for (const payment of fresh.suggestions)
                    await api(
                        `${root}/${circle.id}/settlements`,
                        alice.token,
                        payment,
                        "POST",
                        201,
                    );
                assert.ok(
                    (await api(`${root}/${circle.id}`, alice.token)).balances.every(
                        (row) => row.net === 0,
                    ),
                );
                await api(
                    `${root}/${circle.id}/members/${bobMember}`,
                    alice.token,
                    undefined,
                    "DELETE",
                );
                await api(`${root}/${circle.id}`, bob.token, undefined, "GET", 404);
                await api(
                    `${root}/${circle.id}/expenses/${expense.id}`,
                    alice.token,
                    { version: expense.version },
                    "DELETE",
                    400,
                );
                assert.equal(
                    (await api(`${root}/${circle.id}`, alice.token)).expenses.totalItems,
                    3,
                    "failed deletion is rolled back",
                );
            },
        );
        await t.test(
            "concurrent edits, repayments and membership changes are serialized",
            async () => {
                const group = await api(
                    root,
                    alice.token,
                    { name: "Concurrent", icon: "home", currency: "SGD" },
                    "POST",
                    201,
                );
                const invitation = await api(
                    `${root}/${group.id}/invitations`,
                    alice.token,
                    { email: "bob@example.com" },
                    "POST",
                    201,
                );
                const joined = await api(
                    `/api/expenditure/circle-invitations/${invitation.id}/accept`,
                    bob.token,
                    {},
                );
                const ownerMember = (await api(`${root}/${group.id}`, alice.token)).me;
                const input = {
                    title: "Shared",
                    currency: "SGD",
                    amount: 100,
                    paid_by: ownerMember,
                    split_mode: "even",
                    shares: [{ member: joined.member }],
                };
                const expense = await api(
                    `${root}/${group.id}/expenses`,
                    alice.token,
                    input,
                    "POST",
                    201,
                );
                async function race(path, token, body, method) {
                    const response = await fetch(base + path, {
                        method,
                        headers: { Authorization: token, "Content-Type": "application/json" },
                        body: body === undefined ? undefined : JSON.stringify(body),
                    });
                    return response.status;
                }

                const edits = await Promise.all(
                    ["One", "Two"].map((title) =>
                        race(
                            `${root}/${group.id}/expenses/${expense.id}`,
                            alice.token,
                            { ...input, title, version: 1 },
                            "PATCH",
                        ),
                    ),
                );
                assert.deepEqual(edits.sort(), [200, 409]);
                const payment = {
                    from_member: joined.member,
                    to_member: ownerMember,
                    currency: "SGD",
                    amount: 100,
                };
                const payments = await Promise.all(
                    [1, 2].map(() =>
                        race(`${root}/${group.id}/settlements`, bob.token, payment, "POST"),
                    ),
                );
                assert.deepEqual(payments.sort(), [201, 400]);
                const [removal, added] = await Promise.all([
                    race(
                        `${root}/${group.id}/members/${joined.member}`,
                        alice.token,
                        undefined,
                        "DELETE",
                    ),
                    race(
                        `${root}/${group.id}/expenses`,
                        bob.token,
                        { ...input, paid_by: joined.member, shares: [{ member: ownerMember }] },
                        "POST",
                    ),
                ]);
                assert.ok(
                    (removal === 200 && added === 404) || (removal === 400 && added === 201),
                    JSON.stringify({ removal, added }),
                );
            },
        );
        await t.test(
            "ownership transfer immediately changes permissions and confirmed deletion cascades",
            async () => {
                await api(
                    `${root}/${circle.id}`,
                    carol.token,
                    { name: "Hijacked", version: circle.version },
                    "PATCH",
                    403,
                );
                for (const fields of [{ owner_member: carolMember }, { owner: carolMember }, { owner: outsider.id }, { owner: alice.id }]) {
                    await api(`${root}/${circle.id}`, alice.token, { ...fields, version: circle.version }, "PATCH", 400);
                }

                circle = await api(
                    `${root}/${circle.id}`,
                    alice.token,
                    {
                        name: "Tokyo",
                        icon: "coffee",
                        owner: carol.id,
                        version: circle.version,
                    },
                    "PATCH",
                );
                assert.equal(circle.is_owner, false);
                assert.equal(circle.owner, carol.id);
                await api(
                    `${root}/${circle.id}/invitations`,
                    alice.token,
                    { email: "new@example.com" },
                    "POST",
                    403,
                );
                await api(
                    `${root}/${circle.id}/members/${carolMember}`,
                    carol.token,
                    undefined,
                    "DELETE",
                    400,
                );
                await api(
                    `${root}/${circle.id}`,
                    carol.token,
                    { confirmation: "Wrong", version: circle.version },
                    "DELETE",
                    400,
                );
                await api(
                    `${root}/${circle.id}`,
                    carol.token,
                    { confirmation: "Tokyo", version: circle.version },
                    "DELETE",
                );
                for (const name of [
                    "circle_members",
                    "circle_invitations",
                    "circle_expenses",
                    "circle_settlements",
                ]) {
                    const records = await api(
                        `/api/collections/${name}/records?filter=${encodeURIComponent(`circle = '${circle.id}'`)}`,
                        admin,
                    );
                    assert.equal(records.totalItems, 0);
                }
            },
        );
        await t.test(
            "account deletion preserves shared ledger identities and cleans up owned circles",
            async () => {
                const privateCircle = (await api(root, outsider.token)).circles[0];
                const ownerMember = (await api(`${root}/${privateCircle.id}`, outsider.token)).me;
                await api(
                    `${root}/${privateCircle.id}/expenses`,
                    outsider.token,
                    {
                        title: "Personal",
                        amount: 100,
                        currency: "JPY",
                        paid_by: ownerMember,
                        split_mode: "even",
                        shares: [{ member: ownerMember }],
                    },
                    "POST",
                    201,
                );
                const group = await api(
                    root,
                    alice.token,
                    { name: "Retained history", icon: "users", currency: "SGD" },
                    "POST",
                    201,
                );
                const invitation = await api(
                    `${root}/${group.id}/invitations`,
                    alice.token,
                    { email: "outside@example.com" },
                    "POST",
                    201,
                );
                const joined = await api(
                    `/api/expenditure/circle-invitations/${invitation.id}/accept`,
                    outsider.token,
                    {},
                );
                const aliceId = (await api(`${root}/${group.id}`, alice.token)).me;
                await api(
                    `${root}/${group.id}/expenses`,
                    alice.token,
                    {
                        title: "Preserved",
                        amount: 100,
                        currency: "SGD",
                        paid_by: aliceId,
                        split_mode: "even",
                        shares: [{ member: joined.member }],
                    },
                    "POST",
                    201,
                );
                await api(
                    `/api/collections/users/records/${outsider.id}`,
                    admin,
                    undefined,
                    "DELETE",
                    204,
                );
                await api(
                    `/api/collections/circles/records/${privateCircle.id}`,
                    admin,
                    undefined,
                    "GET",
                    404,
                );
                const retained = await api(`${root}/${group.id}`, alice.token);
                const former = retained.members.find((m) => m.id === joined.member);
                assert.equal(former.user, "");
                assert.deepEqual(former.expand, {});
                assert.equal(former.name, "Outside");
                assert.equal(former.active, false);
                assert.equal(
                    retained.balances.find((row) => row.member === joined.member).net,
                    -100,
                );
                assert.equal(retained.expenses.totalItems, 1);
            },
        );
        await t.test("monthly Circle filters precede pagination without changing overall balances", async () => {
            const filteredCircle = await api(root, alice.token, { name: "Filtered ledger", icon: "home", currency: "SGD" }, "POST", 201);
            const initial = await api(`${root}/${filteredCircle.id}`, alice.token);
            const invitation = await api(`${root}/${filteredCircle.id}/invitations`, alice.token, { email: bob.email }, "POST", 201);
            const joined = await api(`/api/expenditure/circle-invitations/${invitation.id}/accept`, bob.token, {});
            const food = initial.categories.find((row) => row.name === "Food & drinks").id;
            const incomeCategory = initial.categories.find((row) => row.kind === "income").id;
            const transport = initial.categories.find((row) => row.name === "Transport").id;
            async function entry(title, occurred_at, category = food, currency = "SGD", kind = "expense", member = initial.me) {
                return api(`${root}/${filteredCircle.id}/expenses`, alice.token, {
                    title, occurred_at, category, currency, kind, amount: 100,
                    paid_by: initial.me, split_mode: "even", shares: [{ member }],
                }, "POST", 201);
            }

            const matches = [];
            for (let index = 0; index < 28; index++) {
                matches.push(await entry(`Matching ${index}`, "2026-11-15T12:00:00+08:00", index === 0 ? incomeCategory : food, "SGD", index === 0 ? "income" : "expense", index === 1 ? joined.member : initial.me));
            }

            const start = await entry("Inclusive Singapore boundary", "2026-11-01T00:00:00+08:00");
            matches.push(start);
            await entry("Before Singapore month", "2026-10-31T23:59:59+08:00");
            await entry("Exclusive Singapore boundary", "2026-12-01T00:00:00+08:00");
            await entry("Other category", "2026-11-12T12:00:00+08:00", transport);
            await entry("Other currency", "2026-11-12T12:00:00+08:00", food, "USD");
            const complete = await api(`${root}/${filteredCircle.id}`, alice.token);
            assert.equal(complete.expenses.totalItems, 33, "Unfiltered callers retain the complete ledger");
            const query = new URLSearchParams({ expense_from: "2026-11-01T00:00:00+08:00", expense_to: "2026-12-01T00:00:00+08:00", expense_category: food, expense_currency: "SGD" });
            const first = await api(`${root}/${filteredCircle.id}?${query}`, alice.token);
            query.set("expense_page", "2");
            const second = await api(`${root}/${filteredCircle.id}?${query}`, alice.token);
            assert.equal(first.expenses.totalItems, 28);
            assert.equal(first.expenses.totalPages, 2);
            assert.equal(first.expenses.items.length, 25);
            assert.equal(second.expenses.items.length, 3);
            assert.deepEqual(new Set([...first.expenses.items, ...second.expenses.items].map((row) => row.id)), new Set(matches.filter((row) => row.kind === "expense").map((row) => row.id)));
            assert.ok([...first.expenses.items, ...second.expenses.items].every((row) => row.kind === "expense"));
            const incomeQuery = new URLSearchParams(query);
            incomeQuery.set("expense_category", incomeCategory);
            incomeQuery.set("expense_page", "1");
            assert.deepEqual((await api(`${root}/${filteredCircle.id}?${incomeQuery}`, alice.token)).expenses.items.map((row) => row.id), [matches[0].id]);
            assert.ok([...first.expenses.items, ...second.expenses.items].some((row) => row.shares.every((share) => share.member !== initial.me)), "Include entries with no viewer allocation");
            for (const field of ["balances", "suggestions", "totals", "settlements", "categories"]) assert.deepEqual(first[field], complete[field], `${field} stays all-time`);
            query.set("expense_category", "all");
            query.set("expense_currency", "all");
            query.set("expense_page", "1");
            assert.equal((await api(`${root}/${filteredCircle.id}?${query}`, alice.token)).expenses.totalItems, 31);
            query.set("expense_category", transport);
            query.set("expense_currency", "USD");
            assert.equal((await api(`${root}/${filteredCircle.id}?${query}`, alice.token)).expenses.totalItems, 0);
            const unauthorized = await user("FilterOutsider");
            await api(`${root}/${filteredCircle.id}?${query}`, unauthorized.token, undefined, "GET", 404);
            await api(`${root}/${filteredCircle.id}?${query}`, null, undefined, "GET", 401);
            for (const fields of [
                { expense_from: "2026-11-01T00:00:00Z" },
                { expense_from: "2026-12-01T00:00:00Z", expense_to: "2026-11-01T00:00:00Z" },
                { expense_from: "2026-10-01T00:00:00Z", expense_to: "2026-12-01T00:00:00Z" },
                { expense_category: "x\" || true" }, { expense_currency: "FAKE" },
            ]) await api(`${root}/${filteredCircle.id}?${new URLSearchParams(fields)}`, alice.token, undefined, "GET", 400);
        });
    },
);
