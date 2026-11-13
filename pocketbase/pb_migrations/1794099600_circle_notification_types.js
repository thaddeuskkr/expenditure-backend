/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const devices = app.findCollectionByNameOrId("push_devices");
    for (const name of ["circle_expenses", "circle_invitations", "repayments"])
        devices.fields.add(new BoolField({ name }));
    app.save(devices);
    // Existing registrations had notifications enabled. Preserve their tokens,
    // timestamps and pending expense deliveries without resaving records.
    app.db().newQuery("UPDATE push_devices SET circle_expenses = true, circle_invitations = true, repayments = true").execute();
    const jobs = app.findCollectionByNameOrId("push_deliveries");
    jobs.fields.getByName("expense").required = false;
    jobs.fields.getByName("member").required = false;
    for (const [name, collection] of [["invitation", "circle_invitations"], ["settlement", "circle_settlements"]]) {
        jobs.fields.add(new RelationField({ name, collectionId: app.findCollectionByNameOrId(collection).id, maxSelect: 1, cascadeDelete: true }));
    }

    jobs.indexes = [
        "CREATE UNIQUE INDEX idx_push_delivery ON push_deliveries (device, expense) WHERE expense != ''",
        "CREATE UNIQUE INDEX idx_push_invitation ON push_deliveries (device, invitation) WHERE invitation != ''",
        "CREATE UNIQUE INDEX idx_push_settlement ON push_deliveries (device, settlement) WHERE settlement != ''",
        "CREATE INDEX idx_push_due ON push_deliveries (next_attempt)",
    ];
    app.save(jobs);
}, () => {
    throw new Error("Restore a backup to remove invitation and repayment notifications without discarding pending deliveries.");
});
