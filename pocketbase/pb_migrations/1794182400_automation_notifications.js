/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const devices = app.findCollectionByNameOrId("push_devices");
    for (const name of ["shortcut_expenses", "api_expenses"]) devices.fields.add(new BoolField({ name }));
    app.save(devices);
    const jobs = app.findCollectionByNameOrId("push_deliveries");
    jobs.fields.add(new RelationField({ name: "personal_expense", collectionId: app.findCollectionByNameOrId("expenses").id, maxSelect: 1, cascadeDelete: true }));
    jobs.addIndex("idx_push_personal_expense", true, "device, personal_expense", "personal_expense != ''");
    app.save(jobs);
}, () => {
    throw new Error("Restore a backup to remove automation notification preferences without discarding pending alerts.");
});
