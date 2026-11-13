const core = require(`${__hooks}/circles-core.cjs`);
const configuration = require(`${__hooks}/configuration.js`);

function body(e, allowed) {
    const data = e.requestInfo().body;
    if (!data || typeof data !== "object" || Array.isArray(data))
        throw new BadRequestError("Send a JSON object.");
    Object.keys(data).forEach((key) => {
        if (allowed.indexOf(key) < 0) throw new BadRequestError(`Unexpected field: ${key}.`);
    });
    return data;
}

function text(value, label, maximum, required) {
    if (value === undefined && !required) return "";
    if (typeof value !== "string" || value.length > maximum || (required && !value.trim()))
        throw new BadRequestError(
            `${label} must be ${required ? "non-empty text" : "text"} of at most ${maximum} characters.`,
        );
    return required ? value.trim() : value;
}

function currency(code) {
    if (typeof code !== "string" || !configuration.currency(code))
        throw new BadRequestError("Choose a supported currency.");
    return code;
}

function amount(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > core.MAX_AMOUNT)
        throw new BadRequestError("Amount must be a positive integer in currency minor units.");
    return value;
}

function occurredAt(value) {
    return value === undefined ? new Date().toISOString() : require(`${__hooks}/request.js`).timestamp(value);
}

function checkVersion(record, expected) {
    if (!Number.isSafeInteger(expected) || expected !== record.getInt("version"))
        throw new ApiError(409, "This item changed. Reload it before saving again.");
}

function reply(e, data, status) {
    e.response.header().set("Cache-Control", "no-store");
    return e.json(status || 200, data);
}

function write(e, callback, status) {
    let result;
    e.app.runInTransaction((app) => {
        result = callback(app);
    });
    return reply(e, result, status);
}

function record(app, collection, fields) {
    const result = new Record(app.findCollectionByNameOrId(collection));
    result.load(fields);
    app.save(result);
    return result;
}

function find(app, collection, id) {
    if (typeof id !== "string" || !/^[a-z0-9]{15}$/.test(id))
        throw new NotFoundError("Item not found.");
    try {
        return app.findRecordById(collection, id);
    } catch {
        throw new NotFoundError("Item not found.");
    }
}

function memberRecords(app, circle) {
    return app.findRecordsByFilter("circle_members", "circle = {:circle}", "created,id", 0, 0, {
        circle,
    });
}

function access(app, circleId, user, managerOnly) {
    const circle = find(app, "circles", circleId);
    let member;
    try {
        member = app.findFirstRecordByFilter(
            "circle_members",
            "circle = {:circle} && user = {:user} && active = true",
            { circle: circle.id, user },
        );
    } catch {
        throw new NotFoundError("Circle not found.");
    }

    const isOwner = circle.getString("owner") === user;
    const canManage = isOwner || member.getBool("is_admin");
    if (managerOnly && !canManage) throw new ForbiddenError("Only the Circle owner or an Admin can do this.");
    return { circle, member, isOwner, canManage };
}

function displayName(user) {
    return (
        user.getString("name") ||
        user.getString("email").split("@")[0] ||
        "Member"
    ).slice(0, 80);
}

function permissions(circle, member) {
    if (circle.getString("owner") === member.getString("user") || member.getBool("is_admin"))
        return { can_add: true, edit_scope: "all", delete_scope: "all", move_scope: "all" };
    return { can_add: member.getBool("can_add"), edit_scope: member.getString("edit_scope"), delete_scope: member.getString("delete_scope"), move_scope: member.getString("move_scope") };
}

function requireExpensePermission(circle, member, action, expense) {
    const allowed = permissions(circle, member);
    if (action === "move") {
        if (allowed.move_scope === "all" || (allowed.move_scope === "payer" && expense.getString("paid_by") === member.id)) return;
        throw new ForbiddenError("You do not have permission to move this Circle transaction to personal.");
    }

    if (action === "add" ? allowed.can_add : allowed[action + "_scope"] === "all" || (allowed[action + "_scope"] === "own" && expense.getString("created_by") === member.id)) return;
    throw new ForbiddenError(`You do not have permission to ${action} this Circle transaction.`);
}

function memberDTO(app, member) {
    let user = null;
    if (member.getString("user")) {
        try {
            const account = app.findRecordById("users", member.getString("user"));
            user = {
                id: account.id,
                collectionId: account.collection().id,
                avatar: account.getString("avatar"),
                name: account.getString("name"),
            };
        } catch {
            /* The saved membership name survives account deletion. */
        }
    }

    return {
        ...member.publicExport(),
        expand: user ? { user } : {},
    };
}

function circleDTO(app, circle, user) {
    const member = app.findFirstRecordByFilter("circle_members", "circle = {:circle} && user = {:user} && active = true", { circle: circle.id, user });
    return {
        ...circle.publicExport(),
        is_owner: circle.getString("owner") === user,
        can_manage: circle.getString("owner") === user || member.getBool("is_admin"),
        permissions: permissions(circle, member),
        member_count: app.countRecords(
            "circle_members",
            $dbx.exp("circle = {:circle} AND active = true AND user != ''", { circle: circle.id }),
        ),
    };
}

function sharesOf(expense) {
    return JSON.parse(expense.getString("shares"));
}

function balances(app, circle) {
    const rows = arrayOf(new DynamicModel({ member: "", currency: "", net: 0 }));
    app.db()
        .newQuery(
            `
        SELECT member, currency, SUM(delta) AS net FROM (
            SELECT paid_by AS member, currency, CASE WHEN kind = 'income' THEN -amount ELSE amount END AS delta FROM circle_expenses WHERE circle = {:circle}
            UNION ALL
            SELECT json_extract(part.value, '$.member') AS member, expense.currency,
                (CASE WHEN expense.kind = 'income' THEN 1 ELSE -1 END) * CAST(json_extract(part.value, '$.amount') AS INTEGER) AS delta
            FROM circle_expenses AS expense, json_each(expense.shares) AS part WHERE expense.circle = {:circle}
            UNION ALL
            SELECT from_member AS member, currency, amount AS delta FROM circle_settlements WHERE circle = {:circle}
            UNION ALL
            SELECT to_member AS member, currency, -amount AS delta FROM circle_settlements WHERE circle = {:circle}
        ) GROUP BY member, currency
    `,
        )
        .bind({ circle })
        .all(rows);
    return rows.map((row) => ({ member: row.member, currency: row.currency, net: row.net }));
}

function balanceMap(rows) {
    const result = Object.create(null);
    rows.forEach((row) => {
        result[row.member + ":" + row.currency] = row.net;
    });
    return result;
}

function preserveFormerBalances(app, circle, members, before) {
    const former = members
        .filter((member) => !member.getBool("active") || !member.getString("user"))
        .map((member) => member.id);
    if (!former.length) return;
    const previous = balanceMap(before),
        current = balanceMap(balances(app, circle));
    Array.from(new Set(Object.keys(previous).concat(Object.keys(current)))).forEach((key) => {
        if (former.indexOf(key.split(":")[0]) >= 0 && (previous[key] || 0) !== (current[key] || 0))
            throw new BadRequestError(
                "This change would alter a former member's balance. Invite them back before changing this history.",
            );
    });
}

function memberInCircle(members, id, formerAllowed) {
    const member = members.find((item) => item.id === id);
    if (
        !member ||
        ((!member.getBool("active") || !member.getString("user")) &&
            (formerAllowed || []).indexOf(id) < 0)
    )
        throw new BadRequestError("Choose active members of this circle.");
    return member;
}

function expenseFilters(query) {
    const clauses = [], params = {};
    const from = query.get("expense_from"), to = query.get("expense_to");
    if (from || to) {
        const timestamp = require(`${__hooks}/request.js`).timestamp;
        const start = timestamp(from), end = timestamp(to);
        if (end <= start || Date.parse(end) - Date.parse(start) > 32 * 86400000)
            throw new BadRequestError("Provide a valid monthly date range.");
        params.from = start.replace("T", " ");
        params.to = end.replace("T", " ");
        clauses.push("occurred_at >= {:from}", "occurred_at < {:to}");
    }

    const selectedCurrency = query.get("expense_currency") || "all";
    if (selectedCurrency !== "all") {
        params.currency = currency(selectedCurrency);
        clauses.push("currency = {:currency}");
    }

    const category = query.get("expense_category") || "all";
    if (category !== "all") {
        if (!/^[a-z0-9]{15}$/.test(category)) throw new BadRequestError("Choose a valid category.");
        params.category = category;
        clauses.push("category = {:category}");
    }

    const search = (query.get("expense_search") || "").trim();
    if (search.length > 200) throw new BadRequestError("Search must be at most 200 characters.");
    if (search) {
        params.search = search;
        clauses.push("(instr(lower(title), lower({:search})) > 0 OR instr(lower(notes), lower({:search})) > 0 OR instr(lower(payment_method), lower({:search})) > 0)");
    }

    return { clauses, params, sort: require(`${__hooks}/ledger-sort.js`).parse(query, "expense_sort") };
}

function page(app, collection, circle, requested, mapper, filters) {
    const clauses = ["circle = {:circle}"].concat(filters ? filters.clauses : []);
    const params = Object.assign({ circle }, filters ? filters.params : {});
    const total = app.countRecords(collection, $dbx.exp(clauses.join(" AND "), params));
    const pageNumber = Math.max(
        1,
        Math.min(Math.max(1, Math.ceil(total / 25)), parseInt(requested, 10) || 1),
    );
    // The count and page share the same bound SQL, including literal substring search.
    const rows = arrayOf(new Record());
    const order = require(`${__hooks}/ledger-sort.js`).order(filters?.sort || "date_desc", "amount", "currency", ["occurred_at", "created", "id"]);
    app.recordQuery(collection).andWhere($dbx.exp(clauses.join(" AND "), params))
        .orderBy(...order).limit(25).offset((pageNumber - 1) * 25).all(rows);
    return {
        items: rows.map(mapper || ((r) => collection === "circle_expenses" ? configuration.projectCategory(app, r) : r.publicExport())),
        page: pageNumber,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / 25)),
    };
}

function safeInvitation(invitation) {
    return {
        id: invitation.id,
        email: invitation.getString("email"),
        expires_at: invitation.getString("expires_at"),
    };
}

function invitationFor(app, id, auth) {
    const invitation = find(app, "circle_invitations", id);
    if (!auth.getBool("verified"))
        throw new ForbiddenError("Use an account with a verified email to accept invitations.");
    if (invitation.getString("email") !== auth.getString("email").toLowerCase())
        throw new ForbiddenError("Sign in with the account this invitation was sent to.");
    if (
        invitation.getString("revoked_at") ||
        invitation.getString("accepted_at") ||
        Date.parse(invitation.getString("expires_at")) <= Date.now()
    )
        throw new BadRequestError("This invitation has expired or is no longer available.");
    return invitation;
}

function invitationDTO(app, invitation) {
    const circle = find(app, "circles", invitation.getString("circle"));
    return {
        ...safeInvitation(invitation),
        circle: circle.id,
        expand: { circle: {
            id: circle.id,
            name: circle.getString("name"),
            icon: circle.getString("icon"),
            currency: circle.getString("currency"),
        } },
    };
}

function list(e) {
    const memberships = e.app.findRecordsByFilter(
        "circle_members",
        "user = {:user} && active = true",
        "-created",
        0,
        0,
        { user: e.auth.id },
    );
    const circles = memberships.map((member) =>
        circleDTO(e.app, find(e.app, "circles", member.getString("circle")), e.auth.id),
    );
    let invitations = [];
    if (e.auth.getBool("verified")) {
        const pending = e.app.findRecordsByFilter(
            "circle_invitations",
            "email = {:email} && accepted_at = '' && revoked_at = '' && expires_at > {:now}",
            "-created",
            100,
            0,
            {
                email: e.auth.getString("email").toLowerCase(),
                now: new Date().toISOString().replace("T", " "),
            },
        );
        invitations = pending.map((invitation) => invitationDTO(e.app, invitation));
    }

    return reply(e, { circles, invitations });
}

function create(e) {
    const data = body(e, ["name", "icon", "currency"]);
    const name = text(data.name, "Circle name", 80, true);
    const code = currency(
        data.currency === undefined ?
            configuration.preferences(e.app, e.auth.id).currency :
            data.currency,
    );
    const icon = data.icon === undefined ? "users" : data.icon;
    if (core.ICONS.indexOf(icon) < 0) throw new BadRequestError("Choose a supported circle icon.");
    return write(
        e,
        (app) => {
            if (app.countRecords("circles", $dbx.hashExp({ owner: e.auth.id })) >= 50)
                throw new BadRequestError("You can own up to 50 circles.");
            if (
                app.countRecords(
                    "circle_members",
                    $dbx.hashExp({ user: e.auth.id, active: true }),
                ) >= 100
            )
                throw new BadRequestError("You can belong to up to 100 circles.");
            const circle = record(app, "circles", {
                name,
                icon,
                currency: code,
                owner: e.auth.id,
                version: 1,
            });
            record(app, "circle_members", {
                circle: circle.id,
                user: e.auth.id,
                name: displayName(e.auth),
                active: true,
                is_admin: false, can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer", version: 1,
            });
            require(`${__hooks}/circle-categories.js`).initialize(app, circle.id);
            return circleDTO(app, circle, e.auth.id);
        },
        201,
    );
}

function detail(e) {
    const { circle, member, canManage } = access(e.app, e.request.pathValue("id"), e.auth.id);
    const members = memberRecords(e.app, circle.id).map((row) => memberDTO(e.app, row));
    const totals = arrayOf(new DynamicModel({ currency: "", total: 0, income: 0, count: 0 }));
    e.app
        .db()
        .newQuery(
            "SELECT currency, SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) AS total, SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END) AS income, SUM(CASE WHEN kind = 'expense' THEN 1 ELSE 0 END) AS count FROM circle_expenses WHERE circle = {:circle} GROUP BY currency",
        )
        .bind({ circle: circle.id })
        .all(totals);
    const net = balances(e.app, circle.id);
    const query = e.request.url.query();
    const filters = expenseFilters(query);
    const invitations = canManage ?
            e.app
                .findRecordsByFilter(
                    "circle_invitations",
                    "circle = {:circle} && accepted_at = '' && revoked_at = '' && expires_at > {:now}",
                    "-created",
                    100,
                    0,
                    { circle: circle.id, now: new Date().toISOString().replace("T", " ") },
                )
                .map(safeInvitation) :
            [];
    return reply(e, {
        circle: circleDTO(e.app, circle, e.auth.id),
        me: member.id,
        members,
        balances: net,
        suggestions: core.suggestions(net),
        totals: totals.map((row) => ({
            currency: row.currency,
            total: row.total,
            income: row.income,
            count: row.count,
        })),
        invitations,
        categories: require(`${__hooks}/circle-categories.js`).list(e.app, circle.id),
        recurring: e.app.findRecordsByFilter("circle_expenses", "circle = {:circle} && recurrence != ''", "recurrence_next,id", 0, 0, { circle: circle.id }).map((r) => configuration.projectCategory(e.app, r)),
        expenses: page(e.app, "circle_expenses", circle.id, query.get("expense_page"), undefined, filters),
        settlements: page(e.app, "circle_settlements", circle.id, query.get("settlement_page")),
    });
}

function update(e) {
    const data = body(e, ["name", "icon", "currency", "owner", "version"]);
    return write(e, (app) => {
        const { circle, isOwner } = access(app, e.request.pathValue("id"), e.auth.id, true);
        checkVersion(circle, data.version);
        if (data.name !== undefined) circle.set("name", text(data.name, "Circle name", 80, true));
        if (data.icon !== undefined) {
            if (core.ICONS.indexOf(data.icon) < 0)
                throw new BadRequestError("Choose a supported icon.");
            circle.set("icon", data.icon);
        }

        if (data.currency !== undefined) circle.set("currency", currency(data.currency));
        if (data.owner !== undefined) {
            if (!isOwner) throw new ForbiddenError("Only the Circle owner can transfer ownership.");
            const next = memberRecords(app, circle.id).find((member) =>
                member.getBool("active") && member.getString("user") && member.getString("user") === data.owner,
            );
            if (!next) throw new BadRequestError("Choose an active circle member's user ID as owner.");
            if (data.owner === e.auth.id)
                throw new BadRequestError("Choose another member as owner.");
            circle.set("owner", data.owner);
        }

        circle.set("version", circle.getInt("version") + 1);
        app.save(circle);
        return circleDTO(app, circle, e.auth.id);
    });
}

function remove(e) {
    const data = body(e, ["confirmation", "version"]);
    return write(e, (app) => {
        const { circle, isOwner } = access(app, e.request.pathValue("id"), e.auth.id, true);
        if (!isOwner) throw new ForbiddenError("Only the Circle owner can delete the Circle.");
        checkVersion(circle, data.version);
        if (data.confirmation !== circle.getString("name"))
            throw new BadRequestError("Enter the circle name to confirm deletion.");
        app.delete(circle);
        return { deleted: true };
    });
}

function invite(e) {
    const data = body(e, ["email"]);
    const email = text(data.email, "Email", 254, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new BadRequestError("Enter a valid email address.");
    return write(
        e,
        (app) => {
            const { circle } = access(app, e.request.pathValue("id"), e.auth.id, true);
            if (
                memberRecords(app, circle.id).filter(
                    (m) => m.getBool("active") && m.getString("user"),
                ).length >= 50
            )
                throw new BadRequestError("A circle can have up to 50 active members.");
            if (email === e.auth.getString("email").toLowerCase())
                throw new BadRequestError("You already belong to this circle.");
            const matching = app.findRecordsByFilter("users", "email = {:email}", "", 1, 0, {
                email,
            });
            if (
                matching.length &&
                app.countRecords(
                    "circle_members",
                    $dbx.hashExp({ circle: circle.id, user: matching[0].id, active: true }),
                )
            )
                throw new BadRequestError("This person already belongs to the circle.");
            const pending = app.findRecordsByFilter(
                "circle_invitations",
                "circle = {:circle} && email = {:email} && accepted_at = '' && revoked_at = ''",
                "-created",
                0,
                0,
                { circle: circle.id, email },
            );
            // A fresh invitation replaces older links for the same address.
            pending.forEach((old) => {
                old.set("revoked_at", new Date().toISOString());
                app.save(old);
            });
            if (
                app.countRecords(
                    "circle_invitations",
                    $dbx.exp(
                        "circle = {:circle} AND accepted_at = '' AND revoked_at = '' AND expires_at > {:now}",
                        { circle: circle.id, now: new Date().toISOString().replace("T", " ") },
                    ),
                ) >= 100
            )
                throw new BadRequestError("Revoke an invitation before creating another.");
            return safeInvitation(
                record(app, "circle_invitations", {
                    circle: circle.id,
                    email,
                    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
                }),
            );
        },
        201,
    );
}

function previewInvitation(e) {
    return reply(
        e,
        invitationDTO(e.app, invitationFor(e.app, e.request.pathValue("invitation"), e.auth)),
    );
}

function acceptInvitation(e) {
    return write(e, (app) => {
        const invitation = invitationFor(app, e.request.pathValue("invitation"), e.auth);
        const circle = find(app, "circles", invitation.getString("circle"));
        const members = memberRecords(app, circle.id);
        if (members.filter((m) => m.getBool("active") && m.getString("user")).length >= 50)
            throw new BadRequestError("This circle is full.");
        if (
            app.countRecords("circle_members", $dbx.hashExp({ user: e.auth.id, active: true })) >=
            100
        )
            throw new BadRequestError("You can belong to up to 100 circles.");
        let member = members.find((m) => m.getString("user") === e.auth.id);
        if (member) {
            if (member.getBool("active"))
                throw new BadRequestError("You already belong to this circle.");
            member.set("active", true);
            member.set("name", displayName(e.auth));
            member.set("version", member.getInt("version") + 1);
            app.save(member);
        } else {
            member = record(app, "circle_members", {
                circle: circle.id,
                user: e.auth.id,
                name: displayName(e.auth),
                active: true,
                is_admin: false, can_add: true, edit_scope: "own", delete_scope: "own", move_scope: "payer", version: 1,
            });
        }

        invitation.set("accepted_at", new Date().toISOString());
        app.save(invitation);
        return { circle: circle.id, member: member.id };
    });
}

function revokeInvitation(e) {
    return write(e, (app) => {
        const invitation = find(app, "circle_invitations", e.request.pathValue("invitation"));
        const recipient =
            e.auth.getBool("verified") &&
            invitation.getString("email") === e.auth.getString("email").toLowerCase();
        if (!recipient) access(app, invitation.getString("circle"), e.auth.id, true);
        invitation.set("revoked_at", new Date().toISOString());
        app.save(invitation);
        return { revoked: true };
    });
}

function removeMember(e) {
    return write(e, (app) => {
        const { circle, member: actor, canManage } = access(app, e.request.pathValue("id"), e.auth.id);
        const target = find(app, "circle_members", e.request.pathValue("member"));
        if (target.getString("circle") !== circle.id) throw new NotFoundError("Member not found.");
        if (actor.id !== target.id && !canManage)
            throw new ForbiddenError("Only the owner or an Admin can remove another member.");
        if (target.getString("user") === circle.getString("owner"))
            throw new BadRequestError("Transfer ownership before leaving the circle.");
        if (balances(app, circle.id).some((row) => row.member === target.id && row.net !== 0))
            throw new BadRequestError("Settle this member's balances in every currency first.");
        target.set("active", false);
        target.set("version", target.getInt("version") + 1);
        app.save(target);
        return { removed: true };
    });
}

function updateMemberPermissions(e) {
    const data = body(e, ["is_admin", "can_add", "edit_scope", "delete_scope", "move_scope", "version"]);
    if (typeof data.is_admin !== "boolean" || typeof data.can_add !== "boolean" || ["none", "own", "all"].indexOf(data.edit_scope) < 0 || ["none", "own", "all"].indexOf(data.delete_scope) < 0 || ["none", "payer", "all"].indexOf(data.move_scope) < 0)
        throw new BadRequestError("Provide Admin and Add access, Edit and Delete scopes of none, own or all, and a Move scope of none, payer or all.");
    return write(e, (app) => {
        const { circle } = access(app, e.request.pathValue("id"), e.auth.id, true);
        const target = find(app, "circle_members", e.request.pathValue("member"));
        if (target.getString("circle") !== circle.id || !target.getBool("active") || !target.getString("user"))
            throw new NotFoundError("Active member not found.");
        if (target.getString("user") === circle.getString("owner"))
            throw new BadRequestError("The owner always has full access.");
        checkVersion(target, data.version);
        target.load({ is_admin: data.is_admin, can_add: data.can_add, edit_scope: data.edit_scope, delete_scope: data.delete_scope, move_scope: data.move_scope, version: target.getInt("version") + 1 });
        app.save(target);
        return memberDTO(app, target);
    });
}

function createApiExpense(e) {
    return require(`${__hooks}/api-transactions.js`).create(e, e.request.pathValue("id"));
}

function createApiRecord(app, identity, circleId, fields) {
    const { circle, member } = access(app, circleId, identity.user.id);
    requireExpensePermission(circle, member, "add");
    if (app.countRecords("circle_expenses", $dbx.hashExp({ circle: circle.id })) >= 10000)
        throw new BadRequestError("This circle has reached its expense limit.");
    const total = fields.amount;
    const members = memberRecords(app, circle.id), before = balances(app, circle.id);
    const expense = new Record(app.findCollectionByNameOrId("circle_expenses"));
    expense.load({
        circle: circle.id,
        title: fields.merchant,
        kind: "expense",
        recurrence_weekdays: [],
        amount: total,
        currency: fields.currency,
        category: require(`${__hooks}/circle-categories.js`).byName(app, circle.id, fields.category).id,
        paid_by: member.id,
        created_by: member.id,
        split_mode: "percentage",
        shares: core.allocate(total, "percentage", [{ member: member.id, percentage_bp: 10000 }]),
        payment_method: fields.payment_method,
        notes: fields.notes,
        occurred_at: fields.occurred_at,
        source: "api",
        version: 1,
    });
    app.save(expense);
    preserveFormerBalances(app, circle.id, members, before);
    return expense;
}

function saveExpense(e) {
    const data = body(e, [
        "title",
        "category",
        "kind",
        "recurrence",
        "recurrence_interval",
        "recurrence_day",
        "recurrence_weekdays",
        "recurrence_month",
        "amount",
        "currency",
        "paid_by",
        "split_mode",
        "shares",
        "receipt",
        "payment_method",
        "notes",
        "occurred_at",
        "version",
    ]);
    const editing = e.request.pathValue("expense");
    require(`${__hooks}/recurrence.js`).validateInput(data);
    return write(
        e,
        (app) => {
            const { circle, member } = access(app, e.request.pathValue("id"), e.auth.id);
            let expense = null;
            if (editing) {
                expense = find(app, "circle_expenses", editing);
                if (expense.getString("circle") !== circle.id)
                    throw new NotFoundError("Expense not found.");
                requireExpensePermission(circle, member, "edit", expense);
                checkVersion(expense, data.version);
            } else {
                requireExpensePermission(circle, member, "add");
                if (
                    app.countRecords("circle_expenses", $dbx.hashExp({ circle: circle.id })) >= 10000
                ) throw new BadRequestError("This circle has reached its expense limit.");
            }

            const members = memberRecords(app, circle.id),
                before = balances(app, circle.id);
            const formerAllowed = expense ?
                    sharesOf(expense)
                        .map((share) => share.member)
                        .concat(expense.getString("paid_by")) :
                    [];
            const code = currency(data.currency),
                total = amount(data.amount);
            memberInCircle(members, data.paid_by, formerAllowed);
            let shares;
            try {
                shares = core.allocate(
                    total,
                    data.split_mode,
                    data.shares,
                );
            } catch (error) {
                throw new BadRequestError(String(error.message || error));
            }

            const kind = configuration.categoryKind(data.kind === undefined && expense ? expense.getString("kind") : data.kind);
            const receipt = data.receipt === undefined ? (expense ? JSON.parse(expense.getString("receipt") || "null") : null) : data.receipt;
            if (receipt !== null) {
                try {
                    const calculation = require(`${__hooks}/receipt-core.cjs`).calculate(receipt);
                    if (kind !== "expense" || data.split_mode !== "exact" || total !== calculation.amount || shares.length !== calculation.shares.length || shares.some((share) => !calculation.shares.some((expected) => expected.member === share.member && expected.amount === share.amount)))
                        throw new Error("Receipt totals and exact shares must match the calculated expense.");
                    // Check every assigned member, even when their rounded share is zero.
                    receipt.items.forEach((item) => item.members.forEach((id) => memberInCircle(members, id, formerAllowed)));
                } catch (error) {
                    throw new BadRequestError(String(error.message || error));
                }
            }

            shares.forEach((share) => memberInCircle(members, share.member, formerAllowed));
            const shortcut = !expense && e.request.header.get("X-Expenditure-Source") === "shortcut";
            const title = text(data.title, "Title", 160, true);
            const walletTap = shortcut && e.request.header.get("X-Expenditure-Wallet-Tap") === "1";
            const payment = text(data.payment_method, "Payment method", 80, false);
            const fields = {
                circle: circle.id,
                kind,
                recurrence: data.recurrence === undefined ? (expense ? expense.getString("recurrence") : "") : data.recurrence,
                recurrence_interval: data.recurrence_interval === undefined ? (expense ? expense.getInt("recurrence_interval") : 0) : data.recurrence_interval,
                recurrence_day: data.recurrence_day === undefined ? (expense ? expense.getInt("recurrence_day") : 0) : data.recurrence_day,
                recurrence_weekdays: data.recurrence_weekdays === undefined ? (expense ? (JSON.parse(expense.getString("recurrence_weekdays") || "[]") || []) : []) : data.recurrence_weekdays,
                recurrence_month: data.recurrence_month === undefined ? (expense ? expense.getInt("recurrence_month") : 0) : data.recurrence_month,
                title: walletTap ? require(`${__hooks}/shortcut-wallet.js`).resolve(app, e.auth.id, title) : title,
                category: require(`${__hooks}/circle-categories.js`).select(app, circle.id, data.category, expense, kind),
                source: expense ? expense.getString("source") : shortcut ? "shortcut" : "manual",
                amount: total,
                currency: code,
                paid_by: data.paid_by,
                split_mode: data.split_mode,
                shares,
                receipt,
                payment_method: shortcut ? require(`${__hooks}/shortcut-payments.js`).resolve(app, e.auth.id, payment) : payment,
                notes: text(data.notes, "Notes", 2000, false),
                occurred_at: occurredAt(data.occurred_at),
                version: expense ? expense.getInt("version") + 1 : 1,
            };
            if (!expense) expense = new Record(app.findCollectionByNameOrId("circle_expenses"));
            expense.load({ ...fields, recurrence_error: "", created_by: expense.isNew() ? member.id : expense.getString("created_by") });
            require(`${__hooks}/recurrence.js`).configure(expense, app, e.auth.id);
            app.save(expense);
            preserveFormerBalances(app, circle.id, members, before);
            return configuration.projectCategory(app, expense);
        },
        editing ? 200 : 201,
    );
}

function deleteExpense(e) {
    const data = body(e, ["version"]);
    return write(e, (app) => {
        const { circle, member } = access(app, e.request.pathValue("id"), e.auth.id);
        const expense = find(app, "circle_expenses", e.request.pathValue("expense"));
        if (expense.getString("circle") !== circle.id)
            throw new NotFoundError("Expense not found.");
        requireExpensePermission(circle, member, "delete", expense);
        checkVersion(expense, data.version);
        const before = balances(app, circle.id),
            members = memberRecords(app, circle.id);
        app.delete(expense);
        preserveFormerBalances(app, circle.id, members, before);
        return { deleted: true };
    });
}

function settle(e) {
    const editing = e.request.pathValue("settlement");
    const data = body(e, [
        "from_member",
        "to_member",
        "currency",
        "amount",
        "notes",
        "occurred_at",
        ...(editing ? ["version"] : []),
    ]);
    return write(
        e,
        (app) => {
            const { circle, member, canManage } = access(app, e.request.pathValue("id"), e.auth.id);
            let settlement = null;
            if (editing) {
                settlement = find(app, "circle_settlements", editing);
                if (settlement.getString("circle") !== circle.id)
                    throw new NotFoundError("Settlement not found.");
                if (!canManage && settlement.getString("created_by") !== member.id)
                    throw new ForbiddenError("Only the author, owner or an Admin can edit this settlement.");
                checkVersion(settlement, data.version);
            }

            const members = memberRecords(app, circle.id);
            const from = members.find((m) => m.id === data.from_member),
                to = members.find((m) => m.id === data.to_member);
            if (!from || !to || from.id === to.id)
                throw new BadRequestError("Choose two different circle members.");
            const code = currency(data.currency),
                total = amount(data.amount);
            const before = balances(app, circle.id);
            const rows = balanceMap(before);
            if (settlement) {
                // Validate the replacement against balances without this repayment.
                // Keep its ID, creation timestamp and original author intact.
                const fromKey = settlement.getString("from_member") + ":" + settlement.getString("currency");
                const toKey = settlement.getString("to_member") + ":" + settlement.getString("currency");
                rows[fromKey] = (rows[fromKey] || 0) - settlement.getInt("amount");
                rows[toKey] = (rows[toKey] || 0) + settlement.getInt("amount");
            }

            const debt = -(rows[from.id + ":" + code] || 0),
                credit = rows[to.id + ":" + code] || 0;
            const unchangedMoney = settlement && settlement.getString("from_member") === from.id &&
                settlement.getString("to_member") === to.id && settlement.getString("currency") === code &&
                settlement.getInt("amount") === total;
            if (!canManage && member.id !== from.id && member.id !== to.id && !unchangedMoney)
                throw new ForbiddenError(
                    "Only a participant, the owner or an Admin can change this settlement's financial details.",
                );
            if (!unchangedMoney && total > Math.min(debt, credit))
                throw new BadRequestError(
                    "Settlement exceeds the remaining balance in this currency.",
                );
            if (
                !settlement && app.countRecords("circle_settlements", $dbx.hashExp({ circle: circle.id })) >= 10000
            )
                throw new BadRequestError("This circle has reached its settlement limit.");
            const fields = {
                circle: circle.id,
                from_member: from.id,
                to_member: to.id,
                currency: code,
                amount: total,
                notes: settlement && data.notes === undefined ? settlement.getString("notes") : text(data.notes, "Notes", 1000, false),
                occurred_at: settlement && data.occurred_at === undefined ? settlement.getString("occurred_at") : occurredAt(data.occurred_at),
                created_by: settlement ? settlement.getString("created_by") : member.id,
                version: settlement ? settlement.getInt("version") + 1 : 1,
            };
            if (!settlement) settlement = new Record(app.findCollectionByNameOrId("circle_settlements"));
            settlement.load(fields);
            app.save(settlement);
            if (editing) preserveFormerBalances(app, circle.id, members, before);
            return settlement.publicExport();
        },
        editing ? 200 : 201,
    );
}

function deleteSettlement(e) {
    const data = body(e, ["version"]);
    return write(e, (app) => {
        const { circle, member, canManage } = access(app, e.request.pathValue("id"), e.auth.id);
        const settlement = find(app, "circle_settlements", e.request.pathValue("settlement"));
        if (settlement.getString("circle") !== circle.id)
            throw new NotFoundError("Settlement not found.");
        if (!canManage && settlement.getString("created_by") !== member.id)
            throw new ForbiddenError("Only the author, owner or an Admin can undo this settlement.");
        checkVersion(settlement, data.version);
        const before = balances(app, circle.id),
            members = memberRecords(app, circle.id);
        app.delete(settlement);
        preserveFormerBalances(app, circle.id, members, before);
        return { deleted: true };
    });
}

function deleteContents(app, circle) {
    // Delete ledger references before members, including when an owner account
    // deletion cascades into this circle. The caller's transaction owns all work.
    ["circle_settlements", "circle_expenses", "circle_invitations", "circle_categories", "circle_members"].forEach(
        (collection) => {
            app.findRecordsByFilter(collection, "circle = {:circle}", "", 0, 0, { circle }).forEach(
                (item) => app.delete(item),
            );
        },
    );
}

module.exports = {
    access, permissions, requireExpensePermission, memberRecords, memberInCircle, balances, preserveFormerBalances,
    updateMemberPermissions,
    list,
    create,
    detail,
    update,
    remove,
    invite,
    previewInvitation,
    acceptInvitation,
    revokeInvitation,
    removeMember,
    createApiExpense, createApiRecord,
    saveExpense,
    deleteExpense,
    settle,
    deleteSettlement,
    deleteContents,
};
