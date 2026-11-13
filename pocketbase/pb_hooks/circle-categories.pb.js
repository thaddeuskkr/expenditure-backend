onRecordValidate((e) => {
    const record = e.record;
    const original = record.isNew() ? null : record.original();
    if (record.isNew()) {
        if (!record.getString("source")) record.set("source", "manual");
        if (!record.getString("kind")) record.set("kind", "expense");
    }

    record.set("category", require(`${__hooks}/circle-categories.js`).select(
        e.app, record.getString("circle"), record.getString("category") || undefined, original, record.getString("kind"),
    ));

    return e.next();
}, "circle_expenses");

routerAdd("POST", "/api/expenditure/circles/{id}/categories", (e) => require(`${__hooks}/circle-categories.js`).create(e), $apis.requireAuth("users"), $apis.bodyLimit(4096));
routerAdd("PATCH", "/api/expenditure/circles/{id}/categories/{category}", (e) => require(`${__hooks}/circle-categories.js`).update(e), $apis.requireAuth("users"), $apis.bodyLimit(4096));
routerAdd("POST", "/api/expenditure/circles/{id}/categories/reorder", (e) => require(`${__hooks}/circle-categories.js`).reorder(e), $apis.requireAuth("users"), $apis.bodyLimit(8192));
routerAdd("POST", "/api/expenditure/circles/{id}/categories/copy", (e) => require(`${__hooks}/circle-categories.js`).copy(e), $apis.requireAuth("users"), $apis.bodyLimit(8192));
