function installation(e) {
    const value = e.request.pathValue("installation");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new BadRequestError("Use a valid installation identifier.");
    return value.toLowerCase();
}

function preference(type) {
    return { circle_expense: "circle_expenses", circle_invitation: "circle_invitations", circle_repayment: "repayments", shortcut_expense: "shortcut_expenses", api_expense: "api_expenses" }[type];
}

function register(e) {
    const id = installation(e), data = e.requestInfo().body;
    if (!data || Object.keys(data).some((key) => !["token", "environment", "server", "circle_expenses", "circle_invitations", "repayments", "shortcut_expenses", "api_expenses"].includes(key)) ||
        ["circle_expenses", "circle_invitations", "repayments", "shortcut_expenses", "api_expenses"].some((key) => typeof data[key] !== "boolean") ||
        typeof data.server !== "string" || data.server.length > 2048 || !/^https?:\/\//.test(data.server) ||
        typeof data.token !== "string" || !/^(?:[a-f0-9]{2}){16,256}$/i.test(data.token) ||
        !["sandbox", "production"].includes(data.environment))
        throw new BadRequestError("Send an APNs token and sandbox or production environment.");
    e.app.runInTransaction((app) => {
        // An installation belongs to one signed-in account at a time. Replacing
        // it also cancels queued alerts for the previous account/token.
        app.findRecordsByFilter("push_devices", "installation = {:id} || (token = {:token} && environment = {:environment})", "", 0, 0,
            { id, token: data.token.toLowerCase(), environment: data.environment }).forEach((row) => {
            if (row.getString("installation") !== id || row.getString("user") !== e.auth.id || row.getString("token") !== data.token.toLowerCase() || row.getString("environment") !== data.environment || row.getString("server") !== data.server)
                app.delete(row);
        });
        let row;
        try {
            row = app.findFirstRecordByFilter("push_devices", "installation = {:id}", { id });
        } catch {
            row = new Record(app.findCollectionByNameOrId("push_devices"));
        }

        row.load({ installation: id, user: e.auth.id, token: data.token.toLowerCase(), environment: data.environment, server: data.server,
            circle_expenses: data.circle_expenses, circle_invitations: data.circle_invitations, repayments: data.repayments,
            shortcut_expenses: data.shortcut_expenses, api_expenses: data.api_expenses });
        app.save(row);
        removeDisabled(app, row);
    });
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, { registered: true });
}

function unregister(e) {
    const id = installation(e);
    e.app.runInTransaction((app) => {
        app.findRecordsByFilter("push_devices", "installation = {:id} && user = {:user}", "", 0, 0,
            { id, user: e.auth.id }).forEach((row) => app.delete(row));
    });
    return e.noContent(204);
}

function removeDisabled(app, device) {
    for (const job of app.findRecordsByFilter("push_deliveries", "device = {:device}", "", 0, 0, { device: device.id })) {
        const key = preference(JSON.parse(job.getString("payload")).type);
        if (!key || !device.getBool(key)) app.delete(job);
    }
}

function savePreferences(e) {
    const id = installation(e), data = e.requestInfo().body;
    const keys = ["circle_expenses", "circle_invitations", "repayments", "shortcut_expenses", "api_expenses"];
    if (!data || Object.keys(data).some((key) => !keys.includes(key)) || keys.some((key) => typeof data[key] !== "boolean"))
        throw new BadRequestError("Send the five notification choices as booleans.");
    e.app.runInTransaction((app) => {
        for (const device of app.findRecordsByFilter("push_devices", "installation = {:id} && user = {:user}", "", 0, 0, { id, user: e.auth.id })) {
            device.load(data);
            app.save(device);
            removeDisabled(app, device);
        }
    });
    return e.noContent(204);
}

// An explicit one-off test uses the supplied current APNs token without changing
// registrations, saved choices or the activity outbox (including all-off devices).
function testNotification(e) {
    const id = installation(e);
    const data = e.requestInfo().body;
    if (!data || Object.keys(data).some((key) => !["token", "environment", "server", "request_id"].includes(key)) ||
        typeof data.token !== "string" || !/^(?:[a-f0-9]{2}){16,256}$/i.test(data.token) ||
        !["sandbox", "production"].includes(data.environment) || typeof data.server !== "string" ||
        data.server.length > 2048 || !/^https?:\/\//.test(data.server) ||
        typeof data.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.request_id))
        throw new BadRequestError("Send this iPhone’s token, environment, server and test request ID.");
    const registered = e.app.findRecordsByFilter("push_devices", "installation = {:id} || (token = {:token} && environment = {:environment})", "", 0, 0,
        { id, token: data.token.toLowerCase(), environment: data.environment });
    if (registered.some((device) => device.getString("user") !== e.auth.id || device.getString("installation") !== id ||
        device.getString("token") !== data.token.toLowerCase() || device.getString("environment") !== data.environment))
        throw new ForbiddenError("This push registration belongs to a different account or installation. Reopen the app and try again.");
    const url = $os.getenv("EXPENDITURE_PUSH_RELAY_URL"), secret = $os.getenv("EXPENDITURE_PUSH_RELAY_SECRET");
    if (!url || !secret) throw new ApiError(503, "The push relay is not configured on PocketBase.");
    const key = `expenditure_push_test_${e.auth.id}`;
    const lock = key + "_lock", lease = $security.randomString(32);
    if (e.app.store().getOrSet(lock, () => lease) !== lease)
        throw new ApiError(429, "An APNs test is already running. Wait a moment and try again.");
    try {
        const last = e.app.store().get(key) || 0;
        if (Date.now() - last < 10000) throw new ApiError(429, "Wait 10 seconds between APNs tests.");
        e.app.store().set(key, Date.now());
        let response;
        try {
            response = $http.send({ url, method: "POST", timeout: 15,
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
                body: JSON.stringify({ id: data.request_id.replace(/-/g, "").slice(0, 15),
                    token: data.token.toLowerCase(), environment: data.environment,
                    payload: { type: "apns_test", test_id: data.request_id, user: e.auth.id, server: data.server,
                        aps: { alert: { title: "Expenditure", body: "Your APNs test notification has arrived." }, sound: "default" } },
                }),
            });
        } catch {
            throw new ApiError(503, "The push relay could not be reached. Check its URL, secret and connection.");
        }

        if (response.statusCode !== 200 || !response.json)
            throw new ApiError(503, "The push relay rejected the test. Check its configuration and shared secret.");
        if (response.json.result === "invalid")
            throw new BadRequestError("Apple rejected this iPhone’s push token. Reopen the app and try again.");
        if (response.json.result !== "sent")
            throw new ApiError(503, "Apple did not accept the test. Check the relay’s APNs key, topic and environment.");
        e.response.header().set("Cache-Control", "no-store");
        return e.json(200, { status: "accepted", request_id: data.request_id });
    } finally {
        e.app.store().remove(lock);
    }
}

function enqueue(app, record) {
    switch (record.collection().name) {
        case "circle_invitations": return enqueueInvitation(app, record);
        case "circle_settlements": return enqueueRepayment(app, record);
        case "circle_expenses": return enqueueExpense(app, record);
        case "expenses": return enqueueAutomation(app, record);
    }
}

function queue(app, device, circle, target, record, member, payload, body, title = circle ? circle.getString("name") : "Expenditure") {
    if (!device.getBool(preference(payload.type))) return;
    const row = new Record(app.findCollectionByNameOrId("push_deliveries"));
    row.load({
        device: device.id, member: member?.id || "", [target]: record.id,
        attempts: 0, next_attempt: new Date().toISOString(),
        payload: { ...payload,
            aps: { alert: { title, body }, sound: "default", "thread-id": circle ? circle.id : "automation-expenses" },
            ...(circle ? { circle: circle.id } : {}), user: device.getString("user"), server: device.getString("server"),
        },
    });
    app.save(row);
}

function devicesFor(app, user) {
    return app.findRecordsByFilter("push_devices", "user = {:user}", "", 0, 0, { user });
}

function money(record) {
    const currency = record.getString("currency");
    const digits = require(`${__hooks}/configuration.js`).currency(currency).digits;
    return `${currency} ${(record.getInt("amount") / Math.pow(10, digits)).toFixed(digits)}`;
}

function enqueueInvitation(app, invitation) {
    const circle = app.findRecordById("circles", invitation.getString("circle"));
    const users = app.findRecordsByFilter("users", "email:lower = {:email} && verified = true", "", 1, 0, { email: invitation.getString("email") });
    for (const user of users) {
        if (app.countRecords("circle_members", $dbx.hashExp({ circle: circle.id, user: user.id, active: true }))) continue;
        for (const device of devicesFor(app, user.id))
            queue(app, device, circle, "invitation", invitation, null,
                { type: "circle_invitation", invitation: invitation.id }, "You’ve been invited to join this Circle.");
    }
}

function enqueueRepayment(app, settlement) {
    const circle = app.findRecordById("circles", settlement.getString("circle"));
    const author = app.findRecordById("circle_members", settlement.getString("created_by"));
    const from = app.findRecordById("circle_members", settlement.getString("from_member"));
    const to = app.findRecordById("circle_members", settlement.getString("to_member"));
    for (const member of [from, to]) {
        if (!member.getBool("active") || !member.getString("user") || member.getString("user") === author.getString("user")) continue;
        for (const device of devicesFor(app, member.getString("user")))
            queue(app, device, circle, "settlement", settlement, member, {
                type: "circle_repayment", settlement: settlement.id,
                amount: settlement.getInt("amount"), currency: settlement.getString("currency"),
                from_member: from.id, to_member: to.id,
            }, `${author.getString("name")} recorded a repayment of ${money(settlement)} from ${from.getString("name")} to ${to.getString("name")}.`);
    }
}

function enqueueExpense(app, expense) {
    if (expense.getString("kind") !== "expense") return;
    const circle = app.findRecordById("circles", expense.getString("circle"));
    const author = app.findRecordById("circle_members", expense.getString("created_by"));
    const members = app.findRecordsByFilter("circle_members", "circle = {:circle} && active = true && user != '' && user != {:author}", "", 0, 0,
        { circle: circle.id, author: author.getString("user") });
    for (const member of members) {
        for (const device of devicesFor(app, member.getString("user")))
            queue(app, device, circle, "expense", expense, member,
                { type: "circle_expense", expense: expense.id, occurred_at: expense.getString("occurred_at") },
                `${author.getString("name")} spent ${money(expense)} at ${expense.getString("title")}`);
    }

    enqueueAutomation(app, expense, circle, author);
}

// Server-generated copies keep provenance, but are not new Shortcut/API calls.
// Custom record metadata is never stored or included in public exports.
function skipAutomation(record) {
    record.set("_skip_automation_notification", true);
    record.hide("_skip_automation_notification");
}

function enqueueAutomation(app, record, circle, member) {
    const source = record.getString("source");
    if (record.getString("kind") !== "expense" || record.getBool("_skip_automation_notification") || !["shortcut", "api"].includes(source)) return;
    const user = circle ? member.getString("user") : record.getString("user");
    if (!user || (circle && !member.getBool("active"))) return;
    const title = circle ? record.getString("title") : record.getString("merchant");
    const payment = record.getString("payment_method").trim();
    const body = `Spent ${money(record)} at ${title}${source === "api" && payment ? ` on ${payment}` : ""}`;
    const notificationTitle = source === "shortcut" && payment ? payment : undefined;
    for (const device of devicesFor(app, user))
        queue(app, device, circle, circle ? "expense" : "personal_expense", record, member, {
            type: source === "shortcut" ? "shortcut_expense" : "api_expense", expense: record.id, occurred_at: record.getString("occurred_at"),
        }, body, notificationTitle);
}

function eligible(app, job, device, payload) {
    if (!preference(payload.type) || !device.getBool(preference(payload.type)) ||
        payload.user !== device.getString("user") || payload.server !== device.getString("server") ||
        Date.now() - Date.parse(job.getString("created")) >= 86400000) return false;
    if (payload.type === "circle_invitation") {
        const invitation = app.findRecordById("circle_invitations", job.getString("invitation"));
        const user = app.findRecordById("users", device.getString("user"));
        return invitation.id === payload.invitation && invitation.getString("circle") === payload.circle &&
            !invitation.getString("accepted_at") && !invitation.getString("revoked_at") &&
            Date.parse(invitation.getString("expires_at")) > Date.now() && user.getBool("verified") &&
            user.getString("email").toLowerCase() === invitation.getString("email") &&
            !app.countRecords("circle_members", $dbx.hashExp({ circle: payload.circle, user: user.id, active: true }));
    }

    if (["shortcut_expense", "api_expense"].includes(payload.type)) {
        const personal = job.getString("personal_expense");
        const record = app.findRecordById(personal ? "expenses" : "circle_expenses", personal || job.getString("expense"));
        if (record.id !== payload.expense || record.getString("kind") !== "expense" || record.getString("source") !== (payload.type === "shortcut_expense" ? "shortcut" : "api")) return false;
        if (personal) return !payload.circle && record.getString("user") === payload.user && !record.getString("moved_to");
        if (record.getString("created_by") !== job.getString("member")) return false;
    }

    const member = app.findRecordById("circle_members", job.getString("member"));
    if (!member.getBool("active") || member.getString("user") !== device.getString("user") || member.getString("circle") !== payload.circle) return false;
    if (payload.type === "circle_repayment") {
        const settlement = app.findRecordById("circle_settlements", job.getString("settlement"));
        return settlement.id === payload.settlement && settlement.getString("circle") === payload.circle &&
            settlement.getString("from_member") === payload.from_member && settlement.getString("to_member") === payload.to_member &&
            settlement.getInt("amount") === payload.amount && settlement.getString("currency") === payload.currency &&
            [payload.from_member, payload.to_member].includes(member.id);
    }

    return ["circle_expense", "shortcut_expense", "api_expense"].includes(payload.type) && job.getString("expense") === payload.expense;
}

function deliver(app) {
    const url = $os.getenv("EXPENDITURE_PUSH_RELAY_URL"), secret = $os.getenv("EXPENDITURE_PUSH_RELAY_SECRET");
    if (!url || !secret) return;
    // One process-local lock also covers a slow previous cron invocation.
    const lease = $security.randomString(32);
    if (app.store().getOrSet("expenditure_push_running", () => lease) !== lease) return;
    try {
        const jobs = app.findRecordsByFilter("push_deliveries", "next_attempt <= {:now}", "next_attempt,id", 100, 0, { now: new Date().toISOString() });
        for (const job of jobs) {
            try {
                const device = app.findRecordById("push_devices", job.getString("device"));
                const payload = JSON.parse(job.getString("payload"));
                if (!eligible(app, job, device, payload)) {
                    app.delete(job);
                    continue;
                }

                const response = $http.send({
                    url, method: "POST", timeout: 15,
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
                    body: JSON.stringify({ id: job.id, token: device.getString("token"), environment: device.getString("environment"), payload }),
                });
                if (response.statusCode !== 200 || !response.json || !["sent", "invalid", "retry"].includes(response.json.result))
                    throw new Error("Push relay unavailable");
                if (response.json.result === "invalid") app.delete(device);
                else if (response.json.result === "sent") app.delete(job);
                else throw new Error("APNs delivery deferred");
            } catch {
                // Keep payloads/tokens out of logs. A deleted device/expense may
                // have cascaded this job while the network request was in flight.
                try {
                    const current = app.findRecordById("push_deliveries", job.id);
                    const attempts = current.getInt("attempts") + 1;
                    current.set("attempts", attempts);
                    current.set("next_attempt", new Date(Date.now() + Math.min(3600, 60 * Math.pow(2, Math.min(attempts, 6))) * 1000).toISOString());
                    app.save(current);
                } catch { /* Removed jobs need no retry. */ }
            }
        }
    } finally {
        app.store().remove("expenditure_push_running");
    }
}

module.exports = { register, unregister, savePreferences, enqueue, deliver, skipAutomation, testNotification };
