const field = "shortcut_payment_methods";
const maxLinks = 100;
const preferenceFields = [
    "currency", "timezone", "currencies", "payment_methods", field, "default_tab",
    "time_format", "show_circle_transactions", "include_circle_in_budgets",
    "default_entry_currency", "default_expense_category", "default_income_category", "theme",
    "strip_wallet_merchant_location",
];

function clean(label) {
    return label.trim().replace(/\s+/g, " ");
}

function key(label) {
    return clean(label).toLowerCase();
}

function validate(record, methods) {
    const raw = record.getString(field);
    const unchanged = !record.isNew() && raw === record.original().getString(field);
    const links = JSON.parse(raw || "null") ?? [];
    if (!Array.isArray(links) || links.length > maxLinks)
        throw new BadRequestError("Provide up to 100 Shortcut names.");
    const cleaned = [];
    const seen = new Set();
    for (const link of links) {
        if (!link || typeof link.label !== "string" || typeof link.payment_method !== "string")
            throw new BadRequestError("Provide a Shortcut name and payment method for each link.");
        const label = clean(link.label);
        const name = methods.find((method) => key(method) === key(link.payment_method));
        const alias = key(label);
        if (!label || label.length > 80)
            throw new BadRequestError("Shortcut names must contain 1 to 80 characters.");
        if (seen.has(alias))
            throw new BadRequestError("Each Shortcut name can be linked only once.");
        if (!name || methods.some((method) => method !== name && key(method) === alias)) {
            // Older settings clients may rename or remove cards without sending links.
            if (unchanged) continue;
            throw new BadRequestError("Link Shortcut names to saved payment methods and avoid other cards' names.");
        }

        seen.add(alias);
        cleaned.push({ label, payment_method: name });
    }

    record.set(field, cleaned);
}

function resolve(app, user, label) {
    if (!label) return label;
    const record = app.findRecordsByFilter("preferences", "user = {:user}", "", 1, 0, { user })[0];
    const links = record ? JSON.parse(record.getString(field) || "null") ?? [] : [];
    return links.find((link) => key(link.label) === key(label))?.payment_method ?? label;
}

function updateHistory(app, user, links) {
    const targets = new Map(links.map((link) => [key(link.label), link.payment_method]));
    let updated = 0;
    require(`${__hooks}/shortcut-transactions.js`).forEachEditable(app, user, (record, circle) => {
        const label = record.getString("payment_method");
        const target = targets.get(key(label));
        if (!target || target === label) return;
        record.set("payment_method", target);
        if (circle) record.set("version", record.getInt("version") + 1);
        app.save(record);
        updated += 1;
    });

    return updated;
}

function saveWithHistory(e) {
    const data = e.requestInfo().body;
    const edits = data?.preferences;
    const labels = data?.update_shortcut_labels;
    if (!edits || typeof edits !== "object" || Array.isArray(edits) ||
        Object.keys(edits).some((name) => !preferenceFields.includes(name)) ||
        Object.keys(data).some((name) => !["preferences", "update_shortcut_labels"].includes(name)) ||
        !Array.isArray(labels) || !labels.length || labels.length > maxLinks ||
        labels.some((label) => typeof label !== "string" || !clean(label) || label.length > 80))
        throw new BadRequestError("Provide preferences and the Shortcut names to update.");
    let result;
    e.app.runInTransaction((app) => {
        const user = e.auth.id;
        const record = app.findFirstRecordByFilter("preferences", "user = {:user}", { user });
        record.load(edits);
        app.save(record);
        const links = JSON.parse(record.getString(field));
        const keys = new Set(labels.map(key));
        const matching = links.filter((link) => keys.has(key(link.label)));
        if (matching.length !== keys.size)
            throw new BadRequestError("Link each Shortcut name to a payment method before updating history.");
        result = { preferences: record.publicExport(), updated: updateHistory(app, user, matching) };
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, result);
}

module.exports = { validate, resolve, saveWithHistory };
