/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    for (const name of ["expenses", "circle_expenses"]) {
        const collection = app.findCollectionByNameOrId(name);
        collection.fields.getByName("source").values = ["manual", "api", "shortcut"];
        app.save(collection);
    }
}, () => {
    throw new Error("Restore a backup to remove Shortcut provenance without rewriting transaction history.");
});
