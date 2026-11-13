import { resolveCategoryFixture } from "./helpers/category-fixtures.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("Circle search and Shortcut sources preserve pagination, provenance and isolation", { timeout: 60000 }, async (t) => {
    const binary = process.env.POCKETBASE_BINARY;
    assert.ok(binary, "Set POCKETBASE_BINARY to a PocketBase 0.40.6 executable.");
    const directory = await mkdtemp(join(tmpdir(), "expenditure-transaction-feed-"));
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
    async function api(path, { token, key, headers = {}, body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
        ({ path, body } = await resolveCategoryFixture(base, path, body, token));
        const response = await fetch(base + path, {
            method,
            headers: { ...headers, ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

    const owner = await user("ShortcutOwner"), stranger = await user("ShortcutStranger");
    const circle = await api("/api/expenditure/circles", { token: owner.token, body: { name: "Search ledger", currency: "SGD" }, expected: 201 });
    const path = `/api/expenditure/circles/${circle.id}`;
    const initial = await api(path, { token: owner.token });
    const category = initial.categories.find((item) => item.name === "Other").id;
    const config = await api("/api/expenditure/config", { token: owner.token });
    const personalCategory = config.categories.find((item) => item.name === "Other").id;
    const marker = { "X-Expenditure-Source": "shortcut" };
    const input = { title: "Coffee 50% _ 'quoted'", amount: 1250, currency: "SGD", category, paid_by: initial.me, split_mode: "percentage", shares: [{ member: initial.me, percentage_bp: 10000 }], occurred_at: "2026-11-05T04:00:00Z", notes: "Receipt NOTE", payment_method: "Shared Visa" };
    const personalInput = { user: owner.id, merchant: "Shortcut personal", amount: 1250, currency: "SGD", category: personalCategory, occurred_at: input.occurred_at, payment_method: "Visa" };
    let shared = await api(`${path}/expenses`, { token: owner.token, headers: marker, body: input, expected: 201 });
    assert.equal(shared.source, "shortcut");
    const personal = await api("/api/collections/expenses/records", { token: owner.token, headers: marker, body: personalInput });
    assert.equal(personal.source, "shortcut");
    const manual = await api("/api/collections/expenses/records", { token: owner.token, body: { ...personalInput, source: "api" } });
    assert.equal(manual.source, "manual");
    const manualCircle = await api(`${path}/expenses`, { token: owner.token, body: { ...input, title: "Manual" }, expected: 201 });
    assert.equal(manualCircle.source, "manual");
    await api(`${path}/expenses`, { token: owner.token, body: { ...input, source: "shortcut" }, expected: 400 });
    let edited = await api(`/api/collections/expenses/records/${personal.id}`, { token: owner.token, method: "PATCH", body: { merchant: "Edited", source: "manual" } });
    assert.equal(edited.source, "shortcut");
    assert.equal((await api(`/api/collections/expenses/records/${manual.id}`, { token: owner.token, headers: marker, method: "PATCH", body: { notes: "Header cannot rewrite provenance" } })).source, "manual");
    shared = await api(`${path}/expenses/${shared.id}`, { token: owner.token, method: "PATCH", body: { ...input, version: shared.version } });
    assert.equal(shared.source, "shortcut");
    for (let index = 0; index < 29; index++) await api(`${path}/expenses`, { token: owner.token, body: { ...input, title: `Other ${index}`, notes: "", payment_method: "Cash", occurred_at: "2026-11-06T00:00:00Z" }, expected: 201 });
    const before = await api(path, { token: owner.token });
    assert.equal(before.expenses.totalItems, 31);
    assert.ok(!before.expenses.items.some((row) => row.id === shared.id));
    const search = (value, changes = {}, expected = 200) => api(`${path}?${new URLSearchParams({ expense_search: value, ...changes })}`, { token: owner.token, expected });
    for (const query of ["coffee", "receipt note", "shared VISA", "50% _ 'quoted'", "%", "_"]) {
        const found = await search(query);
        // The manual Circle entry shares the payment and note fields only.
        assert.equal(found.expenses.totalItems, ["receipt note", "shared VISA"].includes(query) ? 2 : 1);
        assert.ok(found.expenses.items.some((row) => row.id === shared.id));
        assert.deepEqual(found.balances, before.balances);
        assert.deepEqual(found.totals, before.totals);
        assert.deepEqual(found.suggestions, before.suggestions);
        assert.deepEqual(found.settlements, before.settlements);
    }

    assert.equal((await search("' OR 1=1 --")).expenses.totalItems, 0);
    assert.equal((await search("   ")).expenses.totalItems, 31);
    const page = await search("Other", { expense_page: "2" });
    assert.equal(page.expenses.totalItems, 29);
    assert.equal(page.expenses.items.length, 4);
    assert.equal((await search("coffee", { expense_category: category, expense_currency: "SGD", expense_from: "2026-11-01T00:00:00Z", expense_to: "2026-12-01T00:00:00Z" })).expenses.totalItems, 1);
    assert.equal((await search("coffee", { expense_currency: "JPY" })).expenses.totalItems, 0);
    assert.equal((await search("coffee", { expense_from: "2026-10-01T00:00:00Z", expense_to: "2026-11-01T00:00:00Z" })).expenses.totalItems, 0);
    await search("a".repeat(201), {}, 400);
    await api(`${path}?expense_search=coffee`, { token: stranger.token, expected: 404 });
    await api(`${path}/expenses`, { token: stranger.token, headers: marker, body: input, expected: 404 });
    await api("/api/collections/expenses/records", { headers: marker, body: personalInput, expected: 400 });
    const moved = await api(`${path}/expenses/move`, { token: owner.token, body: { expense: edited.id, previous_updated: edited.updated, category } });
    assert.equal(moved.source, "shortcut");
    edited = await api(`${path}/expenses/${moved.id}/move-to-personal`, { token: owner.token, body: { version: moved.version, category: personalCategory } });
    assert.equal(edited.source, "shortcut");
    const read = (collection, id, token = admin) => api(`/api/collections/${collection}/records/${id}`, { token });
    const savePreferences = (body, expected = 200) => api(`/api/collections/preferences/records/${config.preferences.id}`, { token: owner.token, method: "PATCH", body, expected });
    const preferences = {
        payment_methods: ["Everyday Card", "Joint Card"],
        shortcut_payment_methods: [
            { label: "  Visa  ", payment_method: "Everyday Card" },
            { label: "SHARED   Visa", payment_method: "Everyday Card" },
        ],
    };
    assert.deepEqual(config.preferences.shortcut_payment_methods, []);
    const saved = await savePreferences(preferences);
    assert.deepEqual(saved.shortcut_payment_methods.map((item) => item.label), ["Visa", "SHARED Visa"]);
    assert.equal((await read("expenses", edited.id)).payment_method, "Visa");
    await savePreferences({ shortcut_payment_methods: [...saved.shortcut_payment_methods, { label: "vIsa", payment_method: "Joint Card" }] }, 400);
    await savePreferences({ shortcut_payment_methods: [{ label: "Joint Card", payment_method: "Everyday Card" }] }, 400);
    await savePreferences({ shortcut_payment_methods: [{ label: "New bank", payment_method: "Missing" }] }, 400);
    const fresh = await api("/api/collections/expenses/records", {
        token: owner.token, headers: marker, body: { ...personalInput, payment_method: "  viSa  " },
    });
    assert.equal(fresh.payment_method, "Everyday Card");
    assert.equal(Object.hasOwn(fresh, "_resolve_shortcut_payment"), false);
    const unlinked = await api("/api/collections/expenses/records", {
        token: owner.token, headers: marker, body: { ...personalInput, payment_method: "Another bank" },
    });
    assert.equal(unlinked.payment_method, "Another bank");
    const freshCircle = await api(`${path}/expenses`, {
        token: owner.token, headers: marker, body: { ...input, payment_method: "shared     visa" }, expected: 201,
    });
    assert.equal(freshCircle.payment_method, "Everyday Card");

    const member = await api("/api/collections/circle_members/records", {
        token: admin, body: { circle: circle.id, user: stranger.id, name: "Restricted member", active: true, can_add: true, edit_scope: "none", delete_scope: "own", move_scope: "payer", version: 1 },
    });
    const strangerExpense = await api(`${path}/expenses`, {
        token: stranger.token, headers: marker, expected: 201,
        body: { ...input, paid_by: member.id, shares: [{ member: member.id, percentage_bp: 10000 }] },
    });
    assert.equal(strangerExpense.payment_method, "Shared Visa");
    const update = (token, labels, edits = {}, expected = 200) => api("/api/expenditure/preferences/shortcut-payments", {
        token, method: "PATCH", body: { preferences: edits, update_shortcut_labels: labels }, expected,
    });
    await update(undefined, ["Visa"], preferences, 401);
    await update(owner.token, ["Missing"], { payment_methods: ["Replacement"], shortcut_payment_methods: [] }, 400);
    assert.deepEqual((await read("preferences", config.preferences.id)).payment_methods, preferences.payment_methods);
    const baseline = await api(path, { token: owner.token });
    const backfilled = await update(owner.token, ["visa", " Shared   Visa "], preferences);
    assert.equal(backfilled.updated, 2);
    assert.deepEqual(backfilled.preferences.shortcut_payment_methods, saved.shortcut_payment_methods);
    const rewrittenPersonal = await read("expenses", edited.id);
    assert.deepEqual(rewrittenPersonal, { ...edited, payment_method: "Everyday Card", updated: rewrittenPersonal.updated });
    const rewrittenCircle = await read("circle_expenses", shared.id);
    assert.equal(rewrittenCircle.payment_method, "Everyday Card");
    assert.equal(rewrittenCircle.version, shared.version + 1);
    assert.deepEqual(rewrittenCircle.shares, shared.shares);
    assert.equal(rewrittenCircle.amount, shared.amount);
    assert.equal(rewrittenCircle.source, "shortcut");
    assert.equal(rewrittenCircle.created, shared.created);
    const ledger = await api(path, { token: owner.token });
    assert.deepEqual(ledger.balances, baseline.balances);
    assert.deepEqual(ledger.totals, baseline.totals);
    assert.equal((await update(owner.token, ["visa", "shared visa"])).updated, 0);
    assert.equal((await read("expenses", manual.id)).payment_method, "Visa");
    assert.equal((await read("expenses", personal.id)).payment_method, "Visa", "Moved receipt is untouched");
    assert.equal((await read("circle_expenses", manualCircle.id)).payment_method, "Shared Visa");
    assert.equal((await read("circle_expenses", strangerExpense.id)).payment_method, "Shared Visa");
    assert.equal((await update(stranger.token, ["shared visa"], {
        payment_methods: ["Other card"],
        shortcut_payment_methods: [{ label: "Shared Visa", payment_method: "Other card" }],
    })).updated, 0);
    assert.equal((await read("circle_expenses", strangerExpense.id)).payment_method, "Shared Visa", "Edit scope still applies");
    const removed = await savePreferences({ payment_methods: ["Joint Card"] });
    assert.deepEqual(removed.shortcut_payment_methods, []);
    assert.equal((await read("expenses", edited.id)).payment_method, "Everyday Card");
    const cleanup = "/api/expenditure/shortcut-merchant-cleanup";
    const wallet = { ...marker, "X-Expenditure-Wallet-Tap": "1" };
    const createPersonal = (merchant, headers = marker) => api("/api/collections/expenses/records", {
        token: owner.token, headers, body: { ...personalInput, merchant },
    });
    const createCircle = (title, headers = marker) => api(`${path}/expenses`, {
        token: owner.token, headers, body: { ...input, title }, expected: 201,
    });
    const original = "Harbour Bakehouse, Singapore, SG";
    assert.equal(config.preferences.strip_wallet_merchant_location, false);
    const oldWallet = await createPersonal(original, wallet);
    assert.equal(oldWallet.merchant, original);
    const oldCircle = await createCircle("コーヒー店, 東京, JP");
    const circleBefore = await read("circle_expenses", oldCircle.id);
    const editedMeanwhile = await createPersonal("Metro Cafe, Dublin, IE");
    const manualWithLocation = await createPersonal(original, { "X-Expenditure-Wallet-Tap": "1" });
    assert.equal(manualWithLocation.source, "manual");
    assert.equal(manualWithLocation.merchant, original);
    assert.equal((await savePreferences({ strip_wallet_merchant_location: true })).strip_wallet_merchant_location, true);
    for (const [raw, clean] of [
        [original, "Harbour Bakehouse"],
        ["Marché, Montréal, QC, CA", "Marché"],
        ["Roasters, Pike Place, Seattle, WA, US", "Roasters, Pike Place"],
        ["コーヒー店, 東京, JP", "コーヒー店"],
        ["Online shop", "Online shop"],
        ["Shop, City, ZZ", "Shop, City, ZZ"],
        ["Shop, 12345, SG", "Shop, 12345, SG"],
        ["Shop, London, GB, extra", "Shop, London, GB, extra"],
        ["Shop, Paris, Île-de-France, FR", "Shop, Paris, Île-de-France, FR"],
        ["Shop, , Seattle, WA, US", "Shop, , Seattle, WA, US"],
    ]) {
        const entry = await createPersonal(raw, wallet);
        assert.equal(entry.merchant, clean);
        assert.equal(entry.source, "shortcut");
        assert.equal(Object.hasOwn(entry, "_wallet_tap"), false);
    }

    const circleWallet = await createCircle("Boulangerie, Paris, FR", wallet);
    assert.equal(circleWallet.title, "Boulangerie");
    const otherShortcut = await createPersonal(original);
    assert.equal(otherShortcut.merchant, original);
    const reviewed = (await api(cleanup, { token: owner.token })).items;
    const personalPick = reviewed.find((item) => item.id === oldWallet.id);
    const circlePick = reviewed.find((item) => item.id === oldCircle.id);
    const stalePick = reviewed.find((item) => item.id === editedMeanwhile.id);
    assert.deepEqual([personalPick.merchant, circlePick.merchant, circlePick.circle], ["Harbour Bakehouse", "コーヒー店", circle.id]);
    assert.ok(!reviewed.some((item) => item.id === manualWithLocation.id));
    const saveNames = (token, items, expected = 200) => api(cleanup, { token, method: "PATCH", body: { items }, expected });
    await api(cleanup, { expected: 401 });
    await saveNames(stranger.token, [personalPick, circlePick], 409);
    await saveNames(owner.token, [{ ...personalPick, merchant: "Arbitrary rename" }], 400);
    await api(`/api/collections/expenses/records/${editedMeanwhile.id}`, {
        token: owner.token, method: "PATCH", body: { merchant: "Edited by user" },
    });
    await saveNames(owner.token, [personalPick, stalePick], 409);
    assert.equal((await read("expenses", oldWallet.id)).merchant, original, "A stale selection rolls back other changes");
    assert.equal((await saveNames(owner.token, [personalPick, circlePick])).updated, 2);
    const savedPersonal = await read("expenses", oldWallet.id);
    assert.deepEqual(savedPersonal, { ...oldWallet, merchant: "Harbour Bakehouse", updated: savedPersonal.updated });
    const savedCircle = await read("circle_expenses", oldCircle.id);
    assert.deepEqual(savedCircle, { ...circleBefore, title: "コーヒー店", version: circleBefore.version + 1, updated: savedCircle.updated });
    assert.equal((await saveNames(owner.token, [personalPick, circlePick])).updated, 2);
    assert.equal((await read("circle_expenses", oldCircle.id)).version, savedCircle.version, "Repeating a save is safe");
    assert.equal((await read("expenses", otherShortcut.id)).merchant, original, "Unselected suggestions stay unchanged");
    assert.equal((await read("expenses", manualWithLocation.id)).merchant, original);
    assert.equal((await read("expenses", editedMeanwhile.id)).merchant, "Edited by user");
});
