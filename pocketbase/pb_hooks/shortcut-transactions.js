function forEachEditable(app, user, visit) {
    for (const record of app.findRecordsByFilter(
        "expenses", "user = {:user} && source = 'shortcut' && moved_to = ''", "-occurred_at,-id", 0, 0, { user },
    )) visit(record, null);

    const circles = require(`${__hooks}/circles-service.js`);
    for (const member of app.findRecordsByFilter("circle_members", "user = {:user} && active = true", "", 0, 0, { user })) {
        const circle = app.findRecordById("circles", member.getString("circle"));
        if (circles.permissions(circle, member).edit_scope === "none") continue;
        for (const record of app.findRecordsByFilter(
            "circle_expenses", "circle = {:circle} && created_by = {:member} && source = 'shortcut'", "-occurred_at,-id", 0, 0,
            { circle: circle.id, member: member.id },
        )) visit(record, circle);
    }
}

module.exports = { forEachEditable };
