/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    function collection(name, fields, indexes) {
        const result = new Collection({
            name, type: "base", listRule: null, viewRule: null,
            createRule: null, updateRule: null, deleteRule: null,
            fields: [...fields,
                { name: "created", type: "autodate", onCreate: true },
                { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
            ], indexes,
        });
        app.save(result);
        return result;
    }

    function relation(name, target) {
        return { name, type: "relation", collectionId: target.id, required: true, maxSelect: 1, cascadeDelete: true };
    }

    const devices = collection("push_devices", [
        relation("user", app.findCollectionByNameOrId("users")),
        { name: "installation", type: "text", required: true, max: 36 },
        { name: "token", type: "text", required: true, max: 512 },
        { name: "server", type: "text", required: true, max: 2048 },
        { name: "environment", type: "select", required: true, maxSelect: 1, values: ["sandbox", "production"] },
    ], [
        "CREATE UNIQUE INDEX idx_push_installation ON push_devices (installation)",
        "CREATE UNIQUE INDEX idx_push_token ON push_devices (environment, token)",
        "CREATE INDEX idx_push_user ON push_devices (user)",
    ]);
    collection("push_deliveries", [
        relation("device", devices),
        relation("expense", app.findCollectionByNameOrId("circle_expenses")),
        relation("member", app.findCollectionByNameOrId("circle_members")),
        { name: "payload", type: "json", required: true, maxSize: 4096 },
        { name: "attempts", type: "number", onlyInt: true, min: 0 },
        { name: "next_attempt", type: "date", required: true },
    ], [
        "CREATE UNIQUE INDEX idx_push_delivery ON push_deliveries (device, expense)",
        "CREATE INDEX idx_push_due ON push_deliveries (next_attempt)",
    ]);
}, (app) => {
    for (const name of ["push_deliveries", "push_devices"]) app.delete(app.findCollectionByNameOrId(name));
});
