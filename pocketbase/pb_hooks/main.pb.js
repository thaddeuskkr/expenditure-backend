/// <reference path="../pb_data/types.d.ts" />
routerAdd("GET", "/api/expenditure/status", (e) => e.json(200, { version: 46 }), $apis.requireAuth("users"));

routerAdd(
    "GET",
    "/api/expenditure/overview",
    (e) => {
        const range = require(`${__hooks}/request.js`).bounds(e.request.url.query());
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
    }

    return e.next();
}, "expenses");
