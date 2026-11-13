cronAdd("expenditure_exchange_rates", "7 * * * *", () => {
    require(`${__hooks}/exchange-rates.js`).refresh($app);
});

routerAdd("GET", "/api/expenditure/shortcut-merchant-cleanup", (e) =>
    require(`${__hooks}/shortcut-wallet.js`).review(e), $apis.requireAuth("users"));
routerAdd("PATCH", "/api/expenditure/shortcut-merchant-cleanup", (e) =>
    require(`${__hooks}/shortcut-wallet.js`).apply(e), $apis.requireAuth("users"), $apis.bodyLimit(4194304));

routerAdd("PATCH", "/api/expenditure/preferences/shortcut-payments", (e) =>
    require(`${__hooks}/shortcut-payments.js`).saveWithHistory(e),
$apis.requireAuth("users"), $apis.bodyLimit(131072));

routerAdd(
    "GET",
    "/api/expenditure/config",
    (e) => {
        const config = require(`${__hooks}/configuration.js`);
        config.initialize(e.app, e.auth.id);
        const preferences = config.preferences(e.app, e.auth.id);
        const used = arrayOf(new DynamicModel({ currency: "" }));
        e.app
            .db()
            .newQuery(
                "SELECT DISTINCT currency FROM expenses WHERE user = {:user} AND moved_to = '' UNION SELECT DISTINCT currency FROM budgets WHERE user = {:user}" +
                (preferences.show_circle_transactions ?
                    ` UNION SELECT DISTINCT shared.currency FROM circle_expenses shared
                    JOIN circle_members membership ON membership.circle = shared.circle
                    JOIN json_each(shared.shares) allocation ON json_extract(allocation.value, '$.member') = membership.id
                    WHERE membership.user = {:user} AND json_extract(allocation.value, '$.amount') > 0` :
                    ""),
            )
            .bind({ user: e.auth.id })
            .all(used);
        e.response.header().set("Cache-Control", "no-store");
        return e.json(200, {
            preferences,
            categories: config.categories(e.app, e.auth.id),
            used_currencies: used.map((r) => r.currency),
        });
    },
    $apis.requireAuth("users"),
);

routerAdd(
    "POST",
    "/api/expenditure/categories",
    (e) => {
        const config = require(`${__hooks}/configuration.js`);
        config.initialize(e.app, e.auth.id);
        const data = e.requestInfo().body;
        if (Object.keys(data).some((field) => ["name", "color", "kind"].indexOf(field) < 0))
            throw new BadRequestError("Only name, color and kind are accepted.");
        const kind = config.categoryKind(data.kind);
        if (
            typeof data.name !== "string" ||
            !data.name.trim() ||
            data.name.trim().length > 60 ||
            ["overall", "all"].indexOf(data.name.trim().toLowerCase()) >= 0
        )
            throw new BadRequestError(
                "Choose a category name up to 60 characters, other than Overall or All.",
            );
        if (typeof data.color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(data.color))
            throw new BadRequestError("Choose a valid color.");
        let created;
        e.app.runInTransaction((app) => {
            if (
                app.countRecords("categories", $dbx.hashExp({ user: e.auth.id, kind })) >= 100
            )
                throw new BadRequestError("You can have up to 100 categories.");
            if (
                app.countRecords(
                    "categories",
                    $dbx.exp("user = {:user} AND kind = {:kind} AND lower(name) = lower({:name})", {
                        user: e.auth.id, kind,
                        name: data.name.trim(),
                    }),
                )
            )
                throw new BadRequestError("A category with this name already exists.");
            const record = new Record(app.findCollectionByNameOrId("categories"));
            const existing = config.categories(app, e.auth.id, kind);
            record.load({
                user: e.auth.id,
                kind,
                name: data.name.trim(),
                color: data.color,
                active: true,
                sort_order: existing.length ? existing[existing.length - 1].sort_order + 1 : 0,
            });
            app.save(record);
            created = record.publicExport();
        });
        return e.json(201, created);
    },
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);

routerAdd(
    "POST",
    "/api/expenditure/categories/reorder",
    (e) => {
        const config = require(`${__hooks}/configuration.js`);
        const data = e.requestInfo().body;
        function validIds(ids) {
            return Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
                ids.every((id, index) => typeof id === "string" && /^[a-z0-9]{15}$/.test(id) && ids.indexOf(id) === index);
        }

        if (!validIds(data.ids) || !validIds(data.previous_ids) ||
            Object.keys(data).some((key) => ["ids", "previous_ids", "kind"].indexOf(key) < 0))
            throw new BadRequestError("Provide the current and requested category IDs, without duplicates.");
        const kind = config.categoryKind(data.kind);
        let items;
        e.app.runInTransaction((app) => {
            const records = app.findRecordsByFilter(
                "categories", "user = {:user} && kind = {:kind}", "sort_order,created,name,id", 0, 0, { user: e.auth.id, kind },
            );
            const current = records.map((record) => record.id);
            if (data.previous_ids.length !== current.length ||
                current.some((id, index) => id !== data.previous_ids[index]))
                throw new ApiError(409, "Your categories changed. Refresh and try again.");
            if (data.ids.length !== current.length || data.ids.some((id) => current.indexOf(id) < 0))
                throw new BadRequestError("Include each of your categories exactly once.");
            data.ids.forEach((id, index) => {
                const record = records.find((item) => item.id === id);
                if (record.getInt("sort_order") !== index) {
                    record.set("sort_order", index);
                    app.save(record);
                }
            });
            items = config.categories(app, e.auth.id, kind);
        });
        e.response.header().set("Cache-Control", "no-store");
        return e.json(200, { items });
    },
    $apis.requireAuth("users"),
    $apis.bodyLimit(8192),
);

routerAdd(
    "PATCH",
    "/api/expenditure/categories/{id}",
    (e) => {
        const data = e.requestInfo().body;
        if (Object.keys(data).some((field) => ["name", "color", "active"].indexOf(field) < 0))
            throw new BadRequestError("Only name, color and active are accepted.");
        if (
            data.name !== undefined &&
            (typeof data.name !== "string" ||
                !data.name.trim() ||
                data.name.trim().length > 60 ||
                ["overall", "all"].indexOf(data.name.trim().toLowerCase()) >= 0)
        )
            throw new BadRequestError(
                "Choose a category name up to 60 characters, other than Overall or All.",
            );
        if (
            data.color !== undefined &&
            (typeof data.color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(data.color))
        )
            throw new BadRequestError("Choose a valid color.");
        if (data.active !== undefined && typeof data.active !== "boolean")
            throw new BadRequestError("Invalid category status.");
        let updated;
        e.app.runInTransaction((app) => {
            let record;
            try {
                record = app.findFirstRecordByFilter(
                    "categories",
                    "id = {:id} && user = {:user}",
                    { id: e.request.pathValue("id"), user: e.auth.id },
                );
            } catch {
                throw new NotFoundError("Category not found.");
            }

            const kind = record.getString("kind");
            const name =
                data.name === undefined ? record.getString("name") : data.name.trim();
            const active =
                data.active === undefined ? record.getBool("active") : data.active;
            if (
                app.countRecords(
                    "categories",
                    $dbx.exp(
                        "user = {:user} AND kind = {:kind} AND id != {:id} AND lower(name) = lower({:name})",
                        { user: e.auth.id, kind, id: record.id, name },
                    ),
                )
            )
                throw new BadRequestError("A category with this name already exists.");
            if (
                !active &&
                record.getBool("active") &&
                app.countRecords(
                    "categories",
                    $dbx.hashExp({ user: e.auth.id, kind, active: true }),
                ) <= 1
            )
                throw new BadRequestError("Keep at least one active category.");
            record.set("name", name);
            record.set("active", active);
            if (data.color !== undefined) record.set("color", data.color);
            app.save(record);
            if (!active) {
                const preferences = app.findRecordsByFilter("preferences", "user = {:user} && (default_expense_category = {:category} || default_income_category = {:category})", "", 0, 0, { user: e.auth.id, category: record.id });
                preferences.forEach((preference) => {
                    ["default_expense_category", "default_income_category"].forEach((field) => {
                        if (preference.getString(field) === record.id) preference.set(field, "");
                    });
                    app.save(preference);
                });
            }

            updated = record.publicExport();
        });
        return e.json(200, updated);
    },
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);

routerAdd(
    "GET",
    "/api/expenditure/rates",
    (e) => {
        e.response.header().set("Cache-Control", "no-store");
        return e.json(
            200,
            require(`${__hooks}/exchange-rates.js`).refresh(e.app),
        );
    },
    $apis.requireAuth("users"),
);

onRecordCreateRequest((e) => {
    if (e.requestInfo().body.theme === undefined) {
        const themes = require(`${__hooks}/theme-core.cjs`);
        e.record.set("theme", themes.normalizeTheme({ preset: "mauve", colors: themes.presets[0].colors }));
    }

    if (e.requestInfo().body.payment_methods === undefined)
        e.record.set("payment_methods", []);
    if (e.requestInfo().body.include_circle_in_budgets === undefined)
        e.record.set("include_circle_in_budgets", true);
    return e.next();
}, "preferences");

onRecordCreate((e) => require(`${__hooks}/configuration.js`).savePreferences(e), "preferences");
onRecordUpdate((e) => require(`${__hooks}/configuration.js`).savePreferences(e), "preferences");

onRecordValidate(
    (e) => {
        require(`${__hooks}/configuration.js`).validate(e.record, e.app);
        return e.next();
    },
    "expenses",
    "budgets",
    "preferences",
);
