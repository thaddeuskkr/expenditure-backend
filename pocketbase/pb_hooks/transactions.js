function list(app, user, query) {
    const sorting = require(`${__hooks}/ledger-sort.js`);
    const sort = sorting.parse(query, "sort");
    const config = require(`${__hooks}/configuration.js`);
    const timestamp = require(`${__hooks}/request.js`).timestamp;
    const from = timestamp(query.get("from")).replace("T", " ");
    const to = timestamp(query.get("to")).replace("T", " ");
    if (to <= from || Date.parse(to.replace(" ", "T")) - Date.parse(from.replace(" ", "T")) > 32 * 86400000)
        throw new BadRequestError("Provide a valid monthly date range.");
    function integer(name, fallback, max) {
        const raw = query.get(name);
        if (!raw) return fallback;
        const value = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max)
            throw new BadRequestError(`Invalid ${name}.`);
        return value;
    }

    const page = integer("page", 1, 1000000), perPage = integer("perPage", 15, 100);
    const currency = query.get("currency") || "all", category = query.get("category") || "all", search = query.get("search").trim();
    if (currency !== "all" && !config.currency(currency)) throw new BadRequestError("Unsupported currency.");
    if ((category !== "all" && category !== "unmapped" && !/^[a-z0-9]{15}$/.test(category)) || search.length > 200) throw new BadRequestError("The category or search is too long.");
    const params = { user, from, to, currency, category: category === "unmapped" ? "" : category, search, limit: perPage, offset: (page - 1) * perPage };
    let sql = `SELECT id, 'expenses' AS collection, occurred_at, created, amount AS sort_amount, currency AS sort_currency, 0 AS allocated_amount,
                      '' AS circle, '' AS circle_name, '' AS circle_icon, 0 AS membership_active
               FROM expenses
               WHERE user = {:user} AND moved_to = '' AND occurred_at >= {:from} AND occurred_at < {:to}
               ${currency === "all" ? "" : "AND currency = {:currency}"}
               ${category === "all" ? "" : "AND category = {:category}"}
               ${search ? "AND (instr(lower(merchant), lower({:search})) > 0 OR instr(lower(notes), lower({:search})) > 0 OR instr(lower(payment_method), lower({:search})) > 0)" : ""}`;
    const includeCircles = config.preferences(app, user).show_circle_transactions;
    const personalCategory = includeCircles ? config.personalCategoryMapper(app, user) : null;
    const categoryDefinitions = config.categories(app, user);
    if (includeCircles) {
        if (category !== "all") {
            const names = arrayOf(new DynamicModel({ category: "" }));
            app.db().newQuery(`SELECT DISTINCT shared.category FROM circle_expenses shared
                JOIN circle_members membership ON membership.circle = shared.circle
                WHERE membership.user = {:user} AND shared.occurred_at >= {:from} AND shared.occurred_at < {:to}`)
                .bind(params).all(names);
            params.circle_categories = JSON.stringify(names.filter((row) => personalCategory(row.category) === params.category).map((row) => row.category));
        }

        sql += ` UNION ALL
            SELECT shared.id, 'circle_expenses' AS collection, shared.occurred_at, shared.created, json_extract(allocation.value, '$.amount') AS sort_amount, shared.currency AS sort_currency,
                   json_extract(allocation.value, '$.amount') AS allocated_amount,
                   shared.circle, circles.name AS circle_name, circles.icon AS circle_icon, membership.active AS membership_active
            FROM circle_members membership
            JOIN circle_expenses shared ON shared.circle = membership.circle
            JOIN circles ON circles.id = shared.circle
            JOIN json_each(shared.shares) allocation ON json_extract(allocation.value, '$.member') = membership.id
            WHERE membership.user = {:user} AND json_extract(allocation.value, '$.amount') > 0
              AND shared.occurred_at >= {:from} AND shared.occurred_at < {:to}
              ${currency === "all" ? "" : "AND shared.currency = {:currency}"}
              ${category === "all" ? "" : "AND shared.category IN (SELECT value FROM json_each({:circle_categories}))"}
              ${search ? "AND (instr(lower(shared.title), lower({:search})) > 0 OR instr(lower(shared.notes), lower({:search})) > 0 OR instr(lower(shared.payment_method), lower({:search})) > 0 OR instr(lower(circles.name), lower({:search})) > 0)" : ""}`;
    }

    const count = new DynamicModel({ total: 0 });
    app.db().newQuery(`SELECT COUNT(*) AS total FROM (${sql})`).bind(params).one(count);
    const rows = arrayOf(new DynamicModel({ id: "", collection: "", occurred_at: "", created: "", sort_amount: 0, sort_currency: "", allocated_amount: 0, circle: "", circle_name: "", circle_icon: "", membership_active: 0 }));
    const order = sorting.order(sort, "sort_amount", "sort_currency", ["occurred_at", "created", "collection", "id"]).join(", ");
    app.db().newQuery(`SELECT * FROM (${sql}) ORDER BY ${order} LIMIT {:limit} OFFSET {:offset}`).bind(params).all(rows);
    return {
        page, perPage, totalItems: count.total, totalPages: Math.ceil(count.total / perPage),
        items: rows.map((row) => {
            const entry = config.projectCategory(app, app.findRecordById(row.collection, row.id));
            if (row.collection === "expenses") return entry;
            const budgetCategory = personalCategory(entry.category);
            return { ...entry, allocated_amount: row.allocated_amount, budget_category: budgetCategory, budget_category_name: categoryDefinitions.find((item) => item.id === budgetCategory)?.name || "Other", membership_active: !!row.membership_active,
                expand: { ...entry.expand, circle: { id: row.circle, name: row.circle_name, icon: row.circle_icon } } };
        }),
    };
}

module.exports = { list };
