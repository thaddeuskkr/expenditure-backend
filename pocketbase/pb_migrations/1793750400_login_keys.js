/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const users = app.findCollectionByNameOrId("users");
    app.save(new Collection({
        name: "login_keys",
        type: "base",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: "user", type: "relation", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true },
            { name: "created", type: "autodate", onCreate: true },
            { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
            { name: "name", type: "text", required: true, max: 80 },
            { name: "key_hash", type: "text", required: true, hidden: true },
            { name: "key_prefix", type: "text", required: true },
            { name: "expires_at", type: "date" },
            { name: "revoked_at", type: "date" },
            { name: "last_used", type: "date" },
        ],
        indexes: [
            "CREATE UNIQUE INDEX idx_login_keys_hash ON login_keys (key_hash)",
            "CREATE INDEX idx_login_keys_owner ON login_keys (user)",
        ],
    }));
}, (app) => app.delete(app.findCollectionByNameOrId("login_keys")));
