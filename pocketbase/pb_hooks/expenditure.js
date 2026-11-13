// Shared helpers are loaded inside each handler: PocketBase isolates handler scopes.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function cleanKey(record) {
    return {
        id: record.id,
        name: record.getString("name"),
        key_prefix: record.getString("key_prefix"),
        scopes: record.getStringSlice("scopes"),
        created: record.getString("created"),
        expires_at: record.getString("expires_at"),
        revoked_at: record.getString("revoked_at"),
        last_used: record.getString("last_used"),
    };
}

function authenticate(e, scope, app) {
    app = app || e.app;
    const secret = e.request.header.get("X-API-Key");
    if (!/^exp_[A-Za-z0-9]{48}$/.test(secret))
        throw new UnauthorizedError("Invalid API key.");
    let key;
    try {
        key = app.findFirstRecordByData(
            "api_keys",
            "key_hash",
            $security.sha256(secret),
        );
    } catch {
        throw new UnauthorizedError("Invalid API key.");
    }

    if (
        !$security.equal(key.getString("key_hash"), $security.sha256(secret)) ||
        key.getString("revoked_at") ||
        (key.getString("expires_at") &&
            new Date(key.getString("expires_at")).getTime() <= Date.now())
    ) {
        throw new UnauthorizedError("This API key is expired or revoked.");
    }

    if (key.getStringSlice("scopes").indexOf(scope) === -1)
        throw new ForbiddenError("This API key does not have the required scope.");
    // Resolve the relation so deleted users can never retain access through a key.
    const user = app.findRecordById("users", key.getString("user"));
    e.response.header().set("Cache-Control", "no-store");
    return { key, user };
}

function touch(app, key) {
    // A stale Record save could undo a concurrent revocation. Update only usage
    // metadata, and throttle writes to once per minute per key.
    app
        .db()
        .newQuery(
            "UPDATE api_keys SET last_used = {:now}, updated = {:now} WHERE id = {:id} AND (last_used = '' OR last_used < {:before})",
        )
        .bind({
            id: key.id,
            now: new Date().toISOString().replace("T", " "),
            before: new Date(Date.now() - 60000).toISOString().replace("T", " "),
        })
        .execute();
}

function optionalText(value, label, maxLength) {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > maxLength)
        throw new BadRequestError(
            `${label} must be a string of at most ${maxLength} characters.`,
        );
    return value;
}

function validateExpense(data, app, user, original, circle) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        throw new BadRequestError("The request body must be a JSON object.");
    if (data.user !== undefined)
        throw new BadRequestError(
            "Ownership is determined by your API key; omit user.",
        );
    const allowed = ["merchant", "amount", "currency", "category", "occurred_at", "payment_method", "notes"];
    if (Object.keys(data).some((field) => allowed.indexOf(field) < 0))
        throw new BadRequestError("Only merchant, amount, currency, category, occurred_at, payment_method and notes are accepted.");
    const config = require(`${__hooks}/configuration.js`);
    // Replays resolve omitted defaults against the original request, independent
    // of later edits, archived categories, and changed currency preferences.
    const preferences = original || config.preferences(app, user);
    const code = data.currency === undefined ? (circle ? circle.getString("currency") : preferences.currency) : data.currency;
    if (typeof code !== "string")
        throw new BadRequestError("Currency must be a supported uppercase currency code.");
    const definition = config.currency(code);
    if (
        typeof data.merchant !== "string" ||
        !data.merchant.trim() ||
        data.merchant.trim().length > 160
    )
        throw new BadRequestError("Merchant is required (up to 160 characters).");
    const amount = data.amount;
    if (
        typeof amount !== "number" ||
        !isFinite(amount) ||
        amount !== Math.floor(amount) ||
        amount < 1 ||
        amount > 99999999999
    )
        throw new BadRequestError(
            "amount must be a positive integer, up to 99999999999.",
        );
    if (!definition) throw new BadRequestError("Unsupported currency.");
    if (!original && !circle && preferences.currencies.indexOf(code) < 0)
        throw new BadRequestError("Enable this currency in Settings first.");
    let categoryName = data.category;
    if (categoryName === undefined) {
        if (original) categoryName = original.category;
        else {
            const available = (circle ? require(`${__hooks}/circle-categories.js`).list(app, circle.id, "expense") : config.categories(app, user, "expense")).filter((item) => item.active);
            const fallback = available.find((c) => c.name === "Other") || available[0];
            if (!fallback)
                throw new BadRequestError("Add an active category in this workspace first.");
            categoryName = fallback.name;
        }
    } else if (
        typeof categoryName !== "string" ||
        !categoryName.trim() ||
        categoryName.trim().length > 60
    ) {
        throw new BadRequestError("Category must be a non-empty string of at most 60 characters.");
    }

    const category = original ?
        categoryName.trim().toLowerCase() === original.category.toLowerCase() ? original.category : categoryName.trim() :
        circle ? require(`${__hooks}/circle-categories.js`).byName(app, circle.id, categoryName.trim()).name : config.categoryByName(app, user, categoryName.trim()).name;
    const paymentMethod = optionalText(data.payment_method, "Payment method", 80);
    const notes = optionalText(data.notes, "Notes", 2000);
    const occurred = data.occurred_at === undefined ?
            new Date().toISOString() :
            require(`${__hooks}/request.js`).timestamp(data.occurred_at);
    return {
        merchant: data.merchant.trim(),
        amount: amount,
        currency: code,
        category,
        occurred_at: occurred,
        notes,
        payment_method: paymentMethod,
    };
}

function bounds(query) {
    const from = query.get("from"),
        to = query.get("to"),
        previous = query.get("previous");
    const fromDate = new Date(from),
        toDate = new Date(to),
        previousDate = new Date(previous);
    if (
        !from ||
        !to ||
        !previous ||
        !isFinite(fromDate.getTime()) ||
        !isFinite(toDate.getTime()) ||
        !isFinite(previousDate.getTime()) ||
        toDate <= fromDate ||
        fromDate <= previousDate ||
        toDate - previousDate > 64 * 86400000
    )
        throw new BadRequestError("Provide a valid monthly date range.");
    const currency = query.get("currency") || "all";
    if (
        currency !== "all" &&
        !require(`${__hooks}/configuration.js`).currency(currency)
    )
        throw new BadRequestError("Unsupported currency.");
    // Match PocketBase's normalized date representation for indexed comparisons.
    function pbDate(date) {
        return date.toISOString().replace("T", " ");
    }

    return {
        from: pbDate(fromDate),
        to: pbDate(toDate),
        previous: pbDate(previousDate),
        currency,
    };
}

module.exports = {
    IDEMPOTENCY_TTL_MS,
    cleanKey,
    authenticate,
    touch,
    validateExpense,
    bounds,
};
