function move(e) {
    const data = e.requestInfo().body;
    if (!data || Object.keys(data).some((key) => ["expense", "previous_updated", "category"].indexOf(key) < 0) || typeof data.expense !== "string" || !/^[a-z0-9]{15}$/.test(data.expense) || typeof data.previous_updated !== "string" || typeof data.category !== "string" || !data.category.trim())
        throw new BadRequestError("Provide the expense ID, previous_updated and a Circle category.");
    let result;
    e.app.runInTransaction((app) => {
        const service = require(`${__hooks}/circles-service.js`);
        const { circle, member } = service.access(app, e.request.pathValue("id"), e.auth.id);
        let personal;
        try {
            personal = app.findFirstRecordByFilter("expenses", "id = {:id} && user = {:user}", { id: data.expense, user: e.auth.id });
        } catch {
            throw new NotFoundError("Expense not found.");
        }

        if (personal.getString("moved_to")) {
            if (personal.getString("moved_circle") !== circle.id) throw new ApiError(409, "This expense has already moved to another Circle.");
            // Retry the move without creating a second entry or overwriting edits.
            try {
                result = require(`${__hooks}/configuration.js`).projectCategory(app, app.findRecordById("circle_expenses", personal.getString("moved_to")));
            } catch {
                throw new ApiError(409, "This expense was already moved and the Circle entry has since been deleted.");
            }

            return;
        }

        service.requireExpensePermission(circle, member, "add");
        if (personal.getString("kind") !== "expense") throw new BadRequestError("Only expenses can be moved to a Circle.");
        if (personal.getString("updated") !== data.previous_updated) throw new ApiError(409, "This expense changed. Refresh it before moving.");
        if (app.countRecords("circle_expenses", $dbx.hashExp({ circle: circle.id })) >= 10000) throw new BadRequestError("This Circle has reached its entry limit.");
        const category = require(`${__hooks}/circle-categories.js`).select(app, circle.id, data.category, null);
        const members = service.memberRecords(app, circle.id), before = service.balances(app, circle.id);
        const shared = new Record(app.findCollectionByNameOrId("circle_expenses"));
        shared.id = personal.id;
        shared.load({
            circle: circle.id, title: personal.getString("merchant"), category,
            kind: "expense", paid_by: member.id, created_by: member.id, version: 1,
            split_mode: "percentage", shares: [{ member: member.id, amount: personal.getInt("amount"), percentage_bp: 10000 }],
            origin_expense: personal.id,
        });
        for (const field of ["amount", "currency", "payment_method", "notes", "occurred_at", "source", "recurrence", "recurrence_interval", "recurrence_day", "recurrence_weekdays", "recurrence_month", "recurrence_timezone", "recurrence_anchor", "recurrence_next", "recurrence_error"]) shared.set(field, personal.get(field));
        require(`${__hooks}/push.js`).skipAutomation(shared);
        app.save(shared);
        app.db().newQuery("UPDATE circle_expenses SET created = {:created}, updated = {:updated} WHERE id = {:id}")
            .bind({ id: shared.id, created: personal.getString("created"), updated: personal.getString("updated") }).execute();
        personal.set("moved_to", shared.id);
        personal.set("moved_circle", circle.id);
        personal.set("recurrence", "");
        app.save(personal);
        service.preserveFormerBalances(app, circle.id, members, before);
        result = require(`${__hooks}/configuration.js`).projectCategory(app, app.findRecordById("circle_expenses", shared.id));
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, result);
}

function personalCategory(app, user, name, kind) {
    const categories = require(`${__hooks}/configuration.js`).categories(app, user, kind).filter((item) => item.active);
    const normalized = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
    const exact = categories.find((item) => item.name === name);
    const matches = categories.filter((item) => normalized(item.name) === normalized(name));
    const selected = exact || (matches.length === 1 ? matches[0] : null) || categories.find((item) => normalized(item.name) === "other") || categories[0];
    if (!selected) throw new BadRequestError("Create an active personal category before moving this transaction.");
    return selected.id;
}

function moveToPersonal(e) {
    const data = e.requestInfo().body;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => ["version", "category"].indexOf(key) < 0) || !Number.isSafeInteger(data.version) || data.version < 1 || (data.category !== undefined && (typeof data.category !== "string" || !/^[a-z0-9]{15}$/.test(data.category))))
        throw new BadRequestError("Provide the current version and optionally an active personal category.");
    const requestedCategory = data.category === undefined ? "" : data.category.trim();
    let result;
    e.app.runInTransaction((app) => {
        const service = require(`${__hooks}/circles-service.js`);
        const configuration = require(`${__hooks}/configuration.js`);
        const { circle, member } = service.access(app, e.request.pathValue("id"), e.auth.id);
        const id = e.request.pathValue("expense");
        if (!/^[a-z0-9]{15}$/.test(id)) throw new NotFoundError("Transaction not found.");
        let shared;
        try {
            shared = app.findRecordById("circle_expenses", id);
        } catch {
            throw new NotFoundError("Transaction not found.");
        }

        if (shared.getString("circle") !== circle.id) throw new NotFoundError("Transaction not found.");
        service.requireExpensePermission(circle, member, "move", shared);
        if (shared.getInt("version") !== data.version) throw new ApiError(409, "This transaction changed. Refresh it before moving.");
        if (["expense", "income"].indexOf(shared.getString("kind")) < 0 || !configuration.currency(shared.getString("currency")) || shared.getInt("amount") < 1 || shared.getInt("amount") > require(`${__hooks}/circles-core.cjs`).MAX_AMOUNT)
            throw new BadRequestError("This transaction has invalid financial data.");
        const kind = shared.getString("kind");
        const category = requestedCategory
            ? configuration.category(app, e.auth.id, requestedCategory, false, kind)
            : personalCategory(app, e.auth.id, app.findRecordById("circle_categories", shared.getString("category")).getString("name"), kind);
        const members = service.memberRecords(app, circle.id), before = service.balances(app, circle.id);
        const personal = new Record(app.findCollectionByNameOrId("expenses"));
        personal.load({ user: e.auth.id, merchant: shared.getString("title"), category });
        for (const field of ["kind", "amount", "currency", "payment_method", "notes", "occurred_at", "source", "recurrence", "recurrence_interval", "recurrence_day", "recurrence_weekdays", "recurrence_month", "recurrence_timezone", "recurrence_anchor", "recurrence_next", "recurrence_error"]) personal.set(field, shared.get(field));
        // Copy only canonical stored ledger values and the server-validated category.
        // New-entry validation would reject disabled historical currencies and reset
        // the saved recurrence timezone/cursor. No client money or ownership is loaded.
        require(`${__hooks}/push.js`).skipAutomation(personal);
        app.saveNoValidate(personal);
        app.db().newQuery("UPDATE expenses SET created = {:created}, updated = {:updated} WHERE id = {:id}")
            .bind({ id: personal.id, created: shared.getString("created"), updated: shared.getString("updated") }).execute();
        app.delete(shared);
        service.preserveFormerBalances(app, circle.id, members, before);
        result = configuration.projectCategory(app, app.findRecordById("expenses", personal.id));
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, result);
}

module.exports = { move, moveToPersonal };
