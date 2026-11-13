const catalog = require(`${__hooks}/currencies.json`);
const defaults = ["SGD", "USD", "EUR", "GBP", "AUD", "MYR"];
const defaultNames = [
    "Food & drinks",
    "Groceries",
    "Transport",
    "Shopping",
    "Entertainment",
    "Bills & utilities",
    "Health",
    "Other",
];
const incomeNames = ["Salary", "Other"];
const colors = [
    "#d6b4d5",
    "#b5baff",
    "#b7b9cf",
    "#d6b79a",
    "#a8b6c5",
    "#e7b9c8",
    "#c3a4af",
    "#a59aaa",
];
const byCode = Object.create(null);
catalog.forEach((c) => {
    byCode[c.code] = c;
});
function currency(code) {
    return byCode[code];
}

function preferences(app, user) {
    const found = app.findRecordsByFilter(
        "preferences",
        "user = {:user}",
        "",
        1,
        0,
        { user },
    );
    if (!found.length) {
        initialize(app, user);
        return preferences(app, user);
    }

    return found[0].publicExport();
}

function categoryKind(value = "expense") {
    if (value !== "expense" && value !== "income") throw new BadRequestError("Choose expense or income.");
    return value;
}

function categories(app, user, kind) {
    const records = app.findRecordsByFilter(
        "categories",
        "user = {:user}",
        "kind,sort_order,created,name,id",
        0,
        0,
        { user },
    );
    if (!records.length) {
        initialize(app, user);
        return categories(app, user, kind);
    }

    return records.map((record) => record.publicExport()).filter((row) => kind === undefined || row.kind === kind);
}

function initialize(app, user) {
    app.runInTransaction((tx) => {
        if (tx.countRecords("preferences", $dbx.hashExp({ user })) === 0) {
            const record = new Record(tx.findCollectionByNameOrId("preferences"));
            record.load({ theme: require(`${__hooks}/theme-core.cjs`).normalizeTheme({ preset: "mauve", colors: require(`${__hooks}/theme-presets.json`)[0].colors }), user, currency: "SGD", timezone: "Asia/Singapore", currencies: defaults, payment_methods: [], default_tab: "Overview", time_format: "24h", show_circle_transactions: false, include_circle_in_budgets: true, default_api_circle: "", default_entry_currency: "", default_expense_category: "", default_income_category: "" });
            tx.save(record);
        }

        const collection = tx.findCollectionByNameOrId("categories");
        for (const [kind, names] of [["expense", defaultNames], ["income", incomeNames]]) {
            if (tx.countRecords("categories", $dbx.hashExp({ user, kind })) > 0) continue;
            names.forEach((name, index) => {
                const record = new Record(collection);
                record.load({ user, kind, name, color: colors[index], active: true, sort_order: index });
                tx.save(record);
            });
        }
    });
}

function category(app, user, id, allowArchived, kind = "expense") {
    const match = categories(app, user, kind).find((item) => item.id === id);
    if (!match || (!match.active && !allowArchived))
        throw new BadRequestError("Choose an active category from your account.");
    return match.id;
}

function categoryByName(app, user, name) {
    const match = categories(app, user, "expense").find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!match || !match.active) throw new BadRequestError("Choose an active category from your account.");
    return match;
}

function projectCategory(app, record) {
    const result = record.publicExport();
    const id = record.getString("category");
    if (id) {
        const category = app.findRecordById(record.collection().name === "circle_expenses" ? "circle_categories" : "categories", id);
        result.expand = Object.assign({}, result.expand, { category: category.publicExport() });
    }

    return result;
}

function personalCategoryMapper(app, user) {
    const personal = categories(app, user);
    const key = (name) => name.trim().replace(/\s+/g, " ").toLowerCase();
    const cached = Object.create(null);
    return (circleCategory) => {
        if (Object.prototype.hasOwnProperty.call(cached, circleCategory)) return cached[circleCategory];
        const shared = app.findRecordById("circle_categories", circleCategory);
        const name = shared.getString("name");
        const matchingKind = personal.filter((item) => item.kind === shared.getString("kind"));
        const exact = matchingKind.find((item) => item.name === name);
        const matches = exact ? [exact] : matchingKind.filter((item) => key(item.name) === key(name));
        const other = matchingKind.find((item) => key(item.name) === "other");
        cached[circleCategory] = matches.length === 1 ? matches[0].id : other?.id || "";
        return cached[circleCategory];
    };
}

function validate(record, app) {
    const name = record.collection().name;
    if (name === "expenses") {
        if (record.isNew() && !record.getString("kind")) record.set("kind", "expense");
        require(`${__hooks}/recurrence.js`).configure(record, app, record.getString("user"));
    }

    if (name === "preferences" && record.isNew() && !record.getString("default_tab")) record.set("default_tab", "Overview");
    if (name === "preferences" && record.isNew() && !record.getString("time_format")) record.set("time_format", "24h");
    const user = record.getString("user");
    const code = record.getString("currency");
    if (!currency(code)) throw new BadRequestError("Unsupported currency.");
    if (name === "preferences") {
        const themes = require(`${__hooks}/theme-core.cjs`);
        try {
            const raw = record.getString("theme");
            record.set("theme", themes.normalizeTheme(raw ? JSON.parse(raw) : record.isNew() ? { preset: "mauve", colors: themes.presets[0].colors } : null));
        } catch (error) {
            throw new BadRequestError(error.message || "Choose a valid theme.");
        }

        let methods;
        try {
            methods = JSON.parse(record.getString("payment_methods") || "null");
        } catch {
            throw new BadRequestError("Payment methods must be a list of names.");
        }

        if (!Array.isArray(methods) || methods.length > 50 || methods.some((method) => typeof method !== "string"))
            throw new BadRequestError("Provide up to 50 payment method names.");
        const cleaned = methods.map((method) => method.trim().replace(/\s+/g, " "));
        if (cleaned.some((method) => !method || method.length > 80))
            throw new BadRequestError("Payment method names must contain 1 to 80 characters.");
        const keys = cleaned.map((method) => method.toLowerCase());
        if (keys.some((key, index) => keys.indexOf(key) !== index))
            throw new BadRequestError("Payment method names must be unique.");
        record.set("payment_methods", cleaned);
        require(`${__hooks}/shortcut-payments.js`).validate(record, cleaned);
        const circle = record.getString("default_api_circle");
        if (circle && (record.isNew() || circle !== record.original().getString("default_api_circle"))) {
            try {
                require(`${__hooks}/circles-service.js`).access(app, circle, user);
            } catch {
                throw new BadRequestError("Choose a Circle you currently belong to as your default API workspace.");
            }
        }

        const selected = record.getStringSlice("currencies");
        if (!selected.length) throw new BadRequestError("Enable at least one currency.");
        if (selected.indexOf(code) < 0)
            throw new BadRequestError("The main currency must be enabled.");
        const entryCurrency = record.getString("default_entry_currency");
        if (entryCurrency && selected.indexOf(entryCurrency) < 0) {
            const original = record.original();
            if (!record.isNew() && entryCurrency === original.getString("default_entry_currency") && original.getStringSlice("currencies").indexOf(entryCurrency) >= 0)
                record.set("default_entry_currency", "");
            else
                throw new BadRequestError("Choose an enabled currency for new transactions.");
        }

        ["expense", "income"].forEach((kind) => {
            const field = `default_${kind}_category`;
            const id = record.getString(field);
            if (!id) return;
            let category;
            try {
                category = app.findRecordById("categories", id);
            } catch {
                throw new BadRequestError("Choose an active category from your account for new transactions.");
            }

            if (category.getString("user") !== user || category.getString("kind") !== kind || !category.getBool("active"))
                throw new BadRequestError("Choose an active category from your account for new transactions.");
        });
    } else {
        const original = record.original();
        const sameCurrency =
            !record.isNew() && code === original.getString("currency");
        if (!sameCurrency && preferences(app, user).currencies.indexOf(code) < 0)
            throw new BadRequestError("Enable this currency in Settings first.");
        const selected = record.getString("category");
        const sameCategory =
            !record.isNew() && selected === original.getString("category");
        if (!(name === "budgets" && selected === ""))
            record.set("category", category(app, user, selected, sameCategory, name === "budgets" ? "expense" : record.getString("kind")));
    }
}

function savePreferences(event) {
    const app = event.app;
    try {
        // Keep category/currency validation and the preference write under the
        // same writer lock as category archiving, including nested saves.
        return app.runInTransaction((tx) => {
            event.app = tx;
            return event.next();
        });
    } finally {
        event.app = app;
    }
}

function deletePersonalContents(app, user) {
    // Required category relations must be released before their category rows.
    for (const collection of ["expenses", "budgets", "preferences", "categories"]) {
        app.findRecordsByFilter(collection, "user = {:user}", "", 0, 0, { user }).forEach((record) => app.delete(record));
    }
}

module.exports = {
    defaultNames,
    incomeNames,
    colors,
    catalog,
    currency,
    preferences,
    categories,
    initialize,
    category,
    categoryKind,
    categoryByName,
    projectCategory,
    deletePersonalContents,
    personalCategoryMapper,
    validate,
    savePreferences,
};
