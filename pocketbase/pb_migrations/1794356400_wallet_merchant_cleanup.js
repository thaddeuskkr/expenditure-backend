/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const preferences = app.findCollectionByNameOrId("preferences");
    preferences.fields.add(new BoolField({ name: "strip_wallet_merchant_location" }));
    app.save(preferences);
}, (app) => {
    const preferences = app.findCollectionByNameOrId("preferences");
    preferences.fields.removeByName("strip_wallet_merchant_location");
    app.save(preferences);
});
