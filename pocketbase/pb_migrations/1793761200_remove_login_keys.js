/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    app.delete(app.findCollectionByNameOrId("login_keys"));
}, () => {
    throw new Error("Removed login credentials cannot be recovered. Restore a backup with its matching application version if a rollback is required.");
});
