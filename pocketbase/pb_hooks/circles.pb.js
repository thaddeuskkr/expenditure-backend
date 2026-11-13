// Each handler loads its module inside PocketBase's isolated callback scope.
routerAdd(
    "GET",
    "/api/expenditure/circles",
    (e) => require(`${__hooks}/circles-service.js`).list(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "POST",
    "/api/expenditure/circles",
    (e) => require(`${__hooks}/circles-service.js`).create(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "GET",
    "/api/expenditure/circles/{id}",
    (e) => require(`${__hooks}/circles-service.js`).detail(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "PATCH",
    "/api/expenditure/circles/{id}",
    (e) => require(`${__hooks}/circles-service.js`).update(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "DELETE",
    "/api/expenditure/circles/{id}",
    (e) => require(`${__hooks}/circles-service.js`).remove(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "POST",
    "/api/expenditure/circles/{id}/invitations",
    (e) => require(`${__hooks}/circles-service.js`).invite(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "GET",
    "/api/expenditure/circle-invitations/{invitation}",
    (e) => require(`${__hooks}/circles-service.js`).previewInvitation(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "POST",
    "/api/expenditure/circle-invitations/{invitation}/accept",
    (e) => require(`${__hooks}/circles-service.js`).acceptInvitation(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "DELETE",
    "/api/expenditure/circle-invitations/{invitation}",
    (e) => require(`${__hooks}/circles-service.js`).revokeInvitation(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "PATCH",
    "/api/expenditure/circles/{id}/members/{member}/permissions",
    (e) => require(`${__hooks}/circles-service.js`).updateMemberPermissions(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "DELETE",
    "/api/expenditure/circles/{id}/members/{member}",
    (e) => require(`${__hooks}/circles-service.js`).removeMember(e),
    $apis.requireAuth("users"),
);
routerAdd(
    "POST",
    "/api/expenditure/circles/{id}/expenses",
    (e) => require(`${__hooks}/circles-service.js`).saveExpense(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(262144),
);
routerAdd(
    "PATCH",
    "/api/expenditure/circles/{id}/expenses/{expense}",
    (e) => require(`${__hooks}/circles-service.js`).saveExpense(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(262144),
);
routerAdd(
    "DELETE",
    "/api/expenditure/circles/{id}/expenses/{expense}",
    (e) => require(`${__hooks}/circles-service.js`).deleteExpense(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);
routerAdd(
    "POST",
    "/api/expenditure/circles/{id}/settlements",
    (e) => require(`${__hooks}/circles-service.js`).settle(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(8192),
);
routerAdd(
    "PATCH",
    "/api/expenditure/circles/{id}/settlements/{settlement}",
    (e) => require(`${__hooks}/circles-service.js`).settle(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(8192),
);
routerAdd(
    "DELETE",
    "/api/expenditure/circles/{id}/settlements/{settlement}",
    (e) => require(`${__hooks}/circles-service.js`).deleteSettlement(e),
    $apis.requireAuth("users"),
    $apis.bodyLimit(4096),
);

onRecordDelete((e) => {
    require(`${__hooks}/circles-service.js`).deleteContents(e.app, e.record.id);
    return e.next();
}, "circles");

onRecordDelete((e) => {
    const app = e.app;
    try {
        return app.runInTransaction((tx) => {
            e.app = tx;
            // Preserve membership IDs for the ledger, with their real stored status.
            tx.findRecordsByFilter("circle_members", "user = {:user}", "", 0, 0, { user: e.record.id }).forEach((member) => {
                member.set("active", false);
                tx.save(member);
            });
            require(`${__hooks}/configuration.js`).deletePersonalContents(tx, e.record.id);
            return e.next();
        });
    } finally {
        e.app = app;
    }
}, "users");
