/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    for (const [name, owner, entries, index] of [
        ["categories", "user", "expenses", "idx_category_owner_name"],
        ["circle_categories", "circle", "circle_expenses", "idx_circle_category_name"],
    ]) {
        const collection = app.findCollectionByNameOrId(name);
        collection.fields.add(new SelectField({ name: "kind", values: ["expense", "income"], maxSelect: 1 }));
        collection.addIndex(index, true, owner + ", kind, lower(name)", "");
        app.save(collection);
        app.db().newQuery(`UPDATE ${name} SET kind = 'expense'`).execute();
        collection.fields.getByName("kind").required = true;
        app.save(collection);

        const referenced = arrayOf(new DynamicModel({ id: "" }));
        app.db().newQuery(`SELECT DISTINCT category AS id FROM ${entries} WHERE kind = 'income'
            ${owner === "user" ? "UNION SELECT default_income_category FROM preferences WHERE default_income_category != ''" : ""}`).all(referenced);
        for (const { id } of referenced) {
            const old = app.findRecordById(name, id);
            const copy = new Record(collection);
            copy.load({
                [owner]: old.getString(owner),
                kind: "income",
                name: old.getString("name"),
                color: old.getString("color"),
                active: old.getBool("active"),
                sort_order: old.getInt("sort_order"),
            });
            app.save(copy);
            // Keep ledger timestamps, versions, recurrence checkpoints and relations other than category.
            app.db().newQuery(`UPDATE ${entries} SET category = {:copy} WHERE kind = 'income' AND category = {:id}`).bind({ copy: copy.id, id }).execute();
            if (owner === "user") {
                app.db().newQuery("UPDATE preferences SET default_income_category = {:copy} WHERE default_income_category = {:id}")
                    .bind({ copy: copy.getBool("active") ? copy.id : "", id }).execute();
            }
        }

        const missing = arrayOf(new DynamicModel({ id: "" }));
        const workspaces = owner === "user" ? "users" : "circles";
        app.db().newQuery(`SELECT workspace.id FROM ${workspaces} workspace WHERE NOT EXISTS (
            SELECT 1 FROM ${name} category WHERE category.${owner} = workspace.id AND category.kind = 'income' AND category.active = true
        )`).all(missing);
        for (const { id } of missing) {
            const categories = app.findRecordsByFilter(name, `${owner} = {:id} && kind = 'income'`, "sort_order", 0, 0, { id });
            const names = new Set(categories.map((record) => record.getString("name").toLowerCase()));
            let label = "Other";
            for (let suffix = 2; names.has(label.toLowerCase()); suffix++) label = `Other (${suffix})`;
            const fallback = new Record(collection);
            fallback.load({
                [owner]: id,
                kind: "income",
                name: label,
                color: "#a59aaa",
                active: true,
                sort_order: categories.length ? categories[categories.length - 1].getInt("sort_order") + 1 : 0,
            });
            app.save(fallback);
        }
    }
}, () => {
    throw new Error("Restore a backup with its matching application version to undo the category split.");
});
