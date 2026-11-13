/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const preferences = app.findCollectionByNameOrId("preferences");
    preferences.fields.add(new JSONField({ name: "shortcut_payment_methods", maxSize: 65536 }));
    app.save(preferences);
    app.db().newQuery("UPDATE preferences SET shortcut_payment_methods = '[]'").execute();
}, (app) => {
    const preferences = app.findCollectionByNameOrId("preferences");
    preferences.fields.removeByName("shortcut_payment_methods");
    app.save(preferences);
});
