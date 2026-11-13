const configuration = require(`${__hooks}/configuration.js`);

function list(app, circle, kind) {
    return app.findRecordsByFilter("circle_categories", "circle = {:circle}", "kind,sort_order,created,name,id", 0, 0, { circle }).map((record) => record.publicExport()).filter((row) => kind === undefined || row.kind === kind);
}

function initialize(app, circle) {
    const collection = app.findCollectionByNameOrId("circle_categories");
    for (const [kind, names] of [["expense", configuration.defaultNames], ["income", configuration.incomeNames]]) {
        names.forEach((name, index) => {
            const record = new Record(collection);
            record.load({ circle, kind, name, color: configuration.colors[index], active: true, sort_order: index });
            app.save(record);
        });
    }
}

function select(app, circle, value, expense, kind = "expense") {
    const categories = list(app, circle, configuration.categoryKind(kind));
    if (value === undefined && expense && kind === expense.getString("kind"))
        value = expense.getString("category");
    if (value === undefined) {
        const fallback = categories.find((row) => row.active && row.name === "Other") || categories.find((row) => row.active);
        if (!fallback) throw new BadRequestError("Add an active category to this circle first.");
        return fallback.id;
    }

    if (typeof value !== "string") throw new BadRequestError("Choose a circle category.");
    const category = categories.find((row) => row.id === value);
    const unchanged = expense && category && category.id === expense.getString("category");
    if (!category || (!category.active && !unchanged)) throw new BadRequestError("Choose an active category from this circle.");
    return category.id;
}

function byName(app, circle, name) {
    const category = list(app, circle, "expense").find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!category || !category.active) throw new BadRequestError("Choose an active category from this circle.");
    return category;
}

function body(e, allowed) {
    const data = e.requestInfo().body;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => allowed.indexOf(key) < 0))
        throw new BadRequestError("Send only the supported category fields.");
    return data;
}

function validate(data) {
    if (data.name !== undefined && (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 60 || ["overall", "all"].indexOf(data.name.trim().toLowerCase()) >= 0))
        throw new BadRequestError("Choose a category name up to 60 characters, other than Overall or All.");
    if (data.color !== undefined && (typeof data.color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(data.color)))
        throw new BadRequestError("Choose a valid color.");
    if (data.active !== undefined && typeof data.active !== "boolean") throw new BadRequestError("Invalid category status.");
}

function write(e, callback, status) {
    let result;
    e.app.runInTransaction((app) => {
        const access = require(`${__hooks}/circles-service.js`).access(app, e.request.pathValue("id"), e.auth.id, true);
        result = callback(app, access.circle.id);
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(status || 200, result);
}

function create(e) {
    const data = body(e, ["name", "color", "kind"]);
    const kind = configuration.categoryKind(data.kind);
    if (data.name === undefined || data.color === undefined) throw new BadRequestError("Provide name and color.");
    validate(data);
    return write(e, (app, circle) => {
        const existing = list(app, circle, kind);
        if (existing.length >= 100) throw new BadRequestError("You can have up to 100 circle categories, including archived categories.");
        if (existing.some((row) => row.name.toLowerCase() === data.name.trim().toLowerCase())) throw new BadRequestError("A category with this name already exists.");
        const record = new Record(app.findCollectionByNameOrId("circle_categories"));
        record.load({ circle, kind, name: data.name.trim(), color: data.color, active: true, sort_order: existing.length ? existing[existing.length - 1].sort_order + 1 : 0 });
        app.save(record);
        return record.publicExport();
    }, 201);
}

function update(e) {
    const data = body(e, ["name", "color", "active"]);
    validate(data);
    return write(e, (app, circle) => {
        let record;
        try {
            record = app.findFirstRecordByFilter("circle_categories", "circle = {:circle} && id = {:id}", { circle, id: e.request.pathValue("category") });
        } catch {
            throw new NotFoundError("Category not found.");
        }

        const previous = record.getString("name");
        const name = data.name === undefined ? previous : data.name.trim();
        const active = data.active === undefined ? record.getBool("active") : data.active;
        const categories = list(app, circle, record.getString("kind"));
        if (categories.some((row) => row.id !== record.id && row.name.toLowerCase() === name.toLowerCase())) throw new BadRequestError("A category with this name already exists.");
        if (!active && record.getBool("active") && categories.filter((row) => row.active).length <= 1) throw new BadRequestError("Keep at least one active category.");
        record.load({ name, active, color: data.color === undefined ? record.getString("color") : data.color });
        app.save(record);
        return record.publicExport();
    });
}

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every((id, index) => typeof id === "string" && /^[a-z0-9]{15}$/.test(id) && ids.indexOf(id) === index);
}

function checkPrevious(items, previous) {
    if (!validIds(previous)) throw new BadRequestError("Provide the current category IDs, without duplicates.");
    if (items.length !== previous.length || items.some((row, index) => row.id !== previous[index])) throw new ApiError(409, "Your categories changed. Refresh and try again.");
}

function reorder(e) {
    const data = body(e, ["ids", "previous_ids", "kind"]);
    const kind = configuration.categoryKind(data.kind);
    if (!validIds(data.ids)) throw new BadRequestError("Provide category IDs, without duplicates.");
    return write(e, (app, circle) => {
        const items = list(app, circle, kind);
        checkPrevious(items, data.previous_ids);
        if (data.ids.length !== items.length || data.ids.some((id) => !items.some((row) => row.id === id))) throw new BadRequestError("Include each circle category exactly once.");
        data.ids.forEach((id, index) => {
            const record = app.findRecordById("circle_categories", id);
            record.set("sort_order", index);
            app.save(record);
        });
        return { items: list(app, circle, kind) };
    });
}

function copy(e) {
    const data = body(e, ["previous_ids", "kind"]);
    const kind = configuration.categoryKind(data.kind);
    return write(e, (app, circle) => {
        const existing = list(app, circle, kind);
        checkPrevious(existing, data.previous_ids);
        // Owners and Admins may copy only from their own personal settings.
        const source = configuration.categories(app, e.auth.id, kind);
        const desired = source.map((row) => row.name.toLowerCase());
        const historical = existing.filter((row) => desired.indexOf(row.name.toLowerCase()) < 0 && app.countRecords("circle_expenses", $dbx.hashExp({ circle, category: row.id })) > 0);
        if (source.length + historical.length > 100) throw new BadRequestError("The replacement and historical categories exceed the limit of 100. Reduce your personal category list first.");
        if (!source.some((row) => row.active)) throw new BadRequestError("Keep at least one active category in your personal settings.");
        existing.filter((row) => desired.indexOf(row.name.toLowerCase()) < 0 && !historical.some((kept) => kept.id === row.id)).forEach((row) => app.delete(app.findRecordById("circle_categories", row.id)));
        source.forEach((row, index) => {
            const match = existing.find((item) => item.name.toLowerCase() === row.name.toLowerCase());
            const record = match ? app.findRecordById("circle_categories", match.id) : new Record(app.findCollectionByNameOrId("circle_categories"));
            record.load({ circle, kind, name: row.name, color: row.color, active: row.active, sort_order: index });
            app.save(record);
        });
        historical.forEach((row, index) => {
            const record = app.findRecordById("circle_categories", row.id);
            record.load({ active: false, sort_order: source.length + index });
            app.save(record);
        });
        return { items: list(app, circle, kind) };
    });
}

module.exports = { list, initialize, select, byName, create, update, reorder, copy };
