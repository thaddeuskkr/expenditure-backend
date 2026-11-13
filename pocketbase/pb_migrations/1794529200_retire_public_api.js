/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    app.delete(app.findCollectionByNameOrId("api_transaction_retries"));
    app.delete(app.findCollectionByNameOrId("api_keys"));

    for (const table of ["expenses", "circle_expenses"]) {
        // Update provenance without firing hooks or changing timestamps, versions, or allocations.
        app.db().newQuery(`UPDATE ${table} SET source = 'shortcut' WHERE source = 'api'`).execute();
        const collection = app.findCollectionByNameOrId(table);
        collection.fields.getByName("source").values = ["manual", "shortcut"];
        app.save(collection);
    }

    const preferences = app.findCollectionByNameOrId("preferences");
    preferences.fields.removeByName("default_api_circle");
    app.save(preferences);

    app.db().newQuery("DELETE FROM push_deliveries WHERE json_extract(payload, '$.type') = 'api_expense'").execute();
    const devices = app.findCollectionByNameOrId("push_devices");
    devices.fields.removeByName("api_expenses");
    app.save(devices);
}, () => {
    throw new Error("Restore a backup with its matching application version to recover retired API credentials and retry records.");
});
