/// <reference path="../pb_data/types.d.ts" />
routerAdd("GET", "/api/expenditure/status", (e) => e.json(200, { version: 45 }));

routerAdd(
    "GET",
    "/api/expenditure/keys",
    (e) => {
        const lib = require(`${__hooks}/expenditure.js`);
        e.response.header().set("Cache-Control", "no-store");
        const keys = e.app.findRecordsByFilter(
            "api_keys",
            "user = {:user}",
            "-created",
            100,
            0,
            { user: e.auth.id },
        );
        return e.json(200, { items: keys.map(lib.cleanKey) });
    },
    $apis.requireAuth("users"),
);

routerAdd(
    "POST",
    "/api/expenditure/keys",
    (e) => {
        const lib = require(`${__hooks}/expenditure.js`);
        const data = e.requestInfo().body;
        if (
            typeof data.name !== "string" ||
            !data.name.trim() ||
            data.name.trim().length > 80
        )
            throw new BadRequestError("Enter a key name (up to 80 characters).");
        const scopes = data.scopes;
        if (
            !Array.isArray(scopes) ||
            scopes.length < 1 ||
            scopes.length > 2 ||
            scopes.some((s) => ["expenses:read", "expenses:write"].indexOf(s) < 0) ||
            (scopes.length === 2 && scopes[0] === scopes[1])
        )
            throw new BadRequestError("Select valid scopes.");
        if (Object.keys(data).some((field) => ["name", "scopes", "expires_at"].indexOf(field) < 0))
            throw new BadRequestError("Only name, scopes and expires_at are accepted.");
        const expiresAt = data.expires_at;
        if (expiresAt !== "") {
            require(`${__hooks}/request.js`).timestamp(expiresAt);
            if (typeof expiresAt !== "string" || Date.parse(expiresAt) <= Date.now())
                throw new BadRequestError("expires_at must be a future ISO date with a timezone, or an empty string for no expiration.");
        }

        let result;
        e.app.runInTransaction((app) => {
            const count = app.countRecords(
                "api_keys",
                $dbx.exp("user = {:user} AND revoked_at = '' AND (expires_at = '' OR expires_at > {:now})", {
                    user: e.auth.id,
                    now: new Date().toISOString().replace("T", " "),
                }),
            );
            if (count >= 20)
                throw new BadRequestError(
                    "You can have up to 20 active keys. Revoke a key first.",
                );
            // Retain a bounded history, so the management list remains complete.
            const history = app.findRecordsByFilter(
                "api_keys",
                "user = {:user}",
                "created",
                0,
                0,
                { user: e.auth.id },
            );
            if (history.length >= 100) {
                const inactive = history.filter(
                    (record) =>
                        record.getString("revoked_at") ||
                        (record.getString("expires_at") &&
                            new Date(record.getString("expires_at")).getTime() <= Date.now()),
                );
                inactive
                    .slice(0, history.length - 99)
                    .forEach((record) => app.delete(record));
            }

            const secret = "exp_" + $security.randomString(48);
            const record = new Record(app.findCollectionByNameOrId("api_keys"));
            record.load({
                user: e.auth.id,
                name: data.name.trim(),
                key_hash: $security.sha256(secret),
                key_prefix: secret.slice(0, 12),
                scopes,
                expires_at: expiresAt,
            });
            app.save(record);
            result = { key: secret, record: lib.cleanKey(record) };
        });
        e.response.header().set("Cache-Control", "no-store");
        return e.json(201, result);
    },
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);

routerAdd(
    "DELETE",
    "/api/expenditure/keys/{id}",
    (e) => {
        let key;
        try {
            key = e.app.findFirstRecordByFilter(
                "api_keys",
                "id = {:id} && user = {:user}",
                { id: e.request.pathValue("id"), user: e.auth.id },
            );
        } catch {
            throw new NotFoundError("API key not found.");
        }

        key.set("revoked_at", new Date().toISOString());
        e.app.save(key);
        return e.json(200, { revoked: true });
    },
    $apis.requireAuth("users"),
);

routerAdd(
    "POST",
    "/api/expenses/transactions",
    (e) => require(`${__hooks}/api-transactions.js`).create(e),
    $apis.bodyLimit(8192),
);

routerAdd("GET", "/api/expenses/categories", (e) => require(`${__hooks}/api-categories.js`).list(e));
routerAdd("GET", "/api/expenses/circles/{id}/categories", (e) => require(`${__hooks}/api-categories.js`).list(e, true));

routerAdd("GET", "/api/expenses/transactions", (e) => {
    const lib = require(`${__hooks}/expenditure.js`);
    const identity = lib.authenticate(e, "expenses:read");
    const query = e.request.url.query();
    const page = Math.max(
        1,
        Math.min(100000, parseInt(query.get("page"), 10) || 1),
    );
    const perPage = Math.max(
        1,
        Math.min(100, parseInt(query.get("perPage"), 10) || 30),
    );
    const params = { user: identity.user.id };
    const records = e.app.findRecordsByFilter(
        "expenses",
        "user = {:user} && moved_to = ''",
        "-occurred_at,-created",
        perPage,
        (page - 1) * perPage,
        params,
    );
    const total = e.app.countRecords(
        "expenses",
        $dbx.hashExp({ user: identity.user.id, moved_to: "" }),
    );
    lib.touch(e.app, identity.key);
    return e.json(200, {
        items: records.map((record) => require(`${__hooks}/configuration.js`).projectCategory(e.app, record)),
        page,
        perPage,
        totalItems: total,
        totalPages: Math.ceil(total / perPage),
    });
});

routerAdd(
    "GET",
    "/api/expenditure/overview",
    (e) => {
        const lib = require(`${__hooks}/expenditure.js`);
        const range = lib.bounds(e.request.url.query());
        const result = require(`${__hooks}/overview.js`).summarize(
            e.app,
            e.auth.id,
            range,
        );
        e.response.header().set("Cache-Control", "no-store");
        return e.json(200, result);
    },
    $apis.requireAuth("users"),
);

// Native collection calls also preserve source provenance and enforce invariants.
onRecordCreateRequest((e) => {
    if (!e.hasSuperuserAuth()) {
        require(`${__hooks}/recurrence.js`).protect(e.record, e.requestInfo().body);
        for (const field of ["moved_to", "moved_circle"]) e.record.set(field, e.record.isNew() ? "" : e.record.original().getString(field));
        const shortcut = e.requestInfo().headers["x_expenditure_source"] === "shortcut";
        e.record.set("source", shortcut ? "shortcut" : "manual");
        if (shortcut) {
            e.record.set("_resolve_shortcut_payment", true);
            e.record.hide("_resolve_shortcut_payment");
            e.record.set("_wallet_tap", e.requestInfo().headers["x_expenditure_wallet_tap"] === "1");
            e.record.hide("_wallet_tap");
        }
    }

    return e.next();
}, "expenses");

onRecordCreate((e) => {
    if (!e.record.getBool("_resolve_shortcut_payment")) return e.next();
    const original = e.app;
    try {
        return original.runInTransaction((app) => {
            e.app = app;
            const user = e.record.getString("user");
            if (e.record.getBool("_wallet_tap")) {
                const merchant = e.record.getString("merchant");
                e.record.set("merchant", require(`${__hooks}/shortcut-wallet.js`).resolve(app, user, merchant));
            }

            const label = e.record.getString("payment_method");
            e.record.set("payment_method", require(`${__hooks}/shortcut-payments.js`).resolve(app, user, label));
            return e.next();
        });
    } finally {
        e.app = original;
    }
}, "expenses");

onRecordUpdateRequest((e) => {
    if (!e.hasSuperuserAuth()) {
        require(`${__hooks}/recurrence.js`).protect(e.record, e.requestInfo().body);
        for (const field of ["moved_to", "moved_circle"]) e.record.set(field, e.record.isNew() ? "" : e.record.original().getString(field));
        e.record.set("source", e.record.original().getString("source"));
        // Editing an API expense must not extend or shorten its retry window.
        if (e.record.getString("source") === "api")
            e.record.set("created", e.record.original().get("created"));
    }

    return e.next();
}, "expenses");
