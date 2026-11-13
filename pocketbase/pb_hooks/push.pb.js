routerAdd("PUT", "/api/expenditure/push/devices/{installation}", (e) =>
    require(`${__hooks}/push.js`).register(e), $apis.requireAuth("users"), $apis.bodyLimit(4096));
routerAdd("DELETE", "/api/expenditure/push/devices/{installation}", (e) =>
    require(`${__hooks}/push.js`).unregister(e), $apis.requireAuth("users"), $apis.bodyLimit(1024));
routerAdd("PATCH", "/api/expenditure/push/devices/{installation}", (e) =>
    require(`${__hooks}/push.js`).savePreferences(e), $apis.requireAuth("users"), $apis.bodyLimit(1024));

routerAdd("POST", "/api/expenditure/push/devices/{installation}/test", (e) =>
    require(`${__hooks}/push.js`).testNotification(e), $apis.requireAuth("users"), $apis.bodyLimit(4096));

// Save the outbox in the source record's transaction. Failed/rolled-back writes and
// idempotent replays never produce a notification.
onRecordCreate((e) => {
    const original = e.app;
    try {
        return original.runInTransaction((tx) => {
            e.app = tx;
            e.next();
            require(`${__hooks}/push.js`).enqueue(tx, e.record);
        });
    } finally {
        e.app = original;
    }
}, "expenses", "circle_expenses", "circle_invitations", "circle_settlements");

cronAdd("expenditure_circle_push", "* * * * *", () => {
    require(`${__hooks}/push.js`).deliver($app);
});
