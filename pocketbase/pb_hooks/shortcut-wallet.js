const countries = new Set(require(`${__hooks}/wallet-country-codes.json`));
const subdivisions = {
    CA: new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" ")),
    US: new Set("AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(" ")),
};

function withoutLocation(label) {
    const parts = label.split(",");
    if (parts.length < 3) return label;
    const country = parts.pop().trim();
    if (!countries.has(country)) return label;
    const region = parts[parts.length - 1].trim();
    if (parts.length >= 3) {
        if (!subdivisions[country]?.has(region)) return label;
        parts.pop();
    }

    const city = parts.pop().trim();
    // City text can include accented and non-Latin names. A lone region code,
    // number, or branch marker is ambiguous and stays as supplied.
    if (!city || /^[A-Z]{2}$/.test(city) || !/^\p{L}[\p{L}\p{M} .’'·-]*$/u.test(city)) return label;
    if (parts.some((part) => !part.trim())) return label;
    return parts.join(",").trim();
}

function resolve(app, user, label) {
    const preferences = app.findRecordsByFilter("preferences", "user = {:user}", "", 1, 0, { user })[0];
    return preferences?.getBool("strip_wallet_merchant_location") ? withoutLocation(label) : label;
}

function review(e) {
    const items = [];
    require(`${__hooks}/shortcut-transactions.js`).forEachEditable(e.app, e.auth.id, (record, circle) => {
        const original = record.getString(circle ? "title" : "merchant");
        const merchant = withoutLocation(original);
        if (merchant === original) return;
        items.push({
            id: record.id, circle: circle?.id ?? "", circle_name: circle?.getString("name") ?? "",
            original, merchant, occurred_at: record.getString("occurred_at"),
            amount: record.getInt("amount"), currency: record.getString("currency"),
        });
    });
    items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id));
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, { items });
}

function apply(e) {
    const items = e.requestInfo().body?.items;
    if (!Array.isArray(items) || !items.length || items.some((item) =>
        !item || typeof item.id !== "string" || !/^[a-z0-9]{15}$/.test(item.id) ||
        typeof item.circle !== "string" || (item.circle && !/^[a-z0-9]{15}$/.test(item.circle)) ||
        typeof item.original !== "string" || typeof item.merchant !== "string" ||
        item.original.length > 320 || item.merchant === item.original || withoutLocation(item.original) !== item.merchant))
        throw new BadRequestError("Select transactions from the merchant cleanup preview.");
    const key = (id, circle) => circle + "/" + id;
    const selected = new Map(items.map((item) => [key(item.id, item.circle), item]));
    if (selected.size !== items.length) throw new BadRequestError("Select each transaction once.");
    e.app.runInTransaction((app) => {
        require(`${__hooks}/shortcut-transactions.js`).forEachEditable(app, e.auth.id, (record, circle) => {
            const id = key(record.id, circle?.id ?? "");
            const item = selected.get(id);
            if (!item) return;
            const field = circle ? "title" : "merchant";
            const current = record.getString(field);
            if (current === item.original) {
                record.set(field, item.merchant);
                if (circle) record.set("version", record.getInt("version") + 1);
                app.save(record);
            } else if (current !== item.merchant) {
                throw new ApiError(409, "A merchant name changed. Review the current transactions and try again.");
            }

            selected.delete(id);
        });
        if (selected.size)
            throw new ApiError(409, "Some transactions are no longer available. Review the current list and try again.");
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, { updated: items.length });
}

module.exports = { resolve, review, apply };
