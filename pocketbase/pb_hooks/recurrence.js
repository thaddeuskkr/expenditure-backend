const frequencies = ["daily", "weekly", "monthly", "yearly"];
const managed = ["recurrence_timezone", "recurrence_anchor", "recurrence_next", "recurrence_error"];
function validateInput(data) {
    for (const [field, minimum, maximum] of [["recurrence_interval", 0, 365], ["recurrence_day", -1, 31], ["recurrence_month", 0, 12]]) {
        if (data[field] !== undefined && (!Number.isInteger(data[field]) || data[field] < minimum || data[field] > maximum))
            throw new BadRequestError(`${field} must be a whole number from ${minimum} to ${maximum}.`);
    }

    if (data.recurrence_weekdays !== undefined && (!Array.isArray(data.recurrence_weekdays) || data.recurrence_weekdays.length > 7 || data.recurrence_weekdays.some((day, index, days) => !Number.isInteger(day) || day < 1 || day > 7 || days.indexOf(day) !== index)))
        throw new BadRequestError("Choose weekdays from Monday to Sunday, without duplicates.");
}

function protect(record, data) {
    // Native record requests expose JSON fields as serialized byte arrays.
    // Read the loaded JSON field, while custom routes validate their raw arrays.
    validateInput({ recurrence_interval: data.recurrence_interval, recurrence_day: data.recurrence_day, recurrence_month: data.recurrence_month });
    if (Object.keys(data).indexOf("recurrence_weekdays") >= 0)
        validateInput({ recurrence_weekdays: JSON.parse(record.getString("recurrence_weekdays") || "null") });
    managed.forEach((field) => record.set(field, record.isNew() ? "" : record.original().getString(field)));
    record.set("recurrence_error", "");
}

function wall(instant, timezone) {
    return new DateTime(instant).time().in(new Timezone(timezone)).format("2006-01-02T15:04:05");
}

function advance(local, frequency, anchor, periods, interval, day, month) {
    const date = new Date(local + "Z");
    if (frequency === "daily" || frequency === "weekly") date.setUTCDate(date.getUTCDate() + periods * interval * (frequency === "daily" ? 1 : 7));
    else {
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + periods * interval * (frequency === "monthly" ? 1 : 12));
        if (frequency === "yearly" && month) date.setUTCMonth(month - 1);
        const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        const requested = day ? (day === -1 ? last : day) : Number(anchor.slice(8, 10));
        date.setUTCDate(Math.min(requested, last));
    }

    return date.toISOString().slice(0, 10) + " " + anchor.slice(11, 19);
}

function instant(target, timezone) {
    // Keep the original wall-clock time even after a DST gap was normalized.
    let result = new DateTime(target, timezone).string();
    // Go can normalize nonexistent spring-forward times backwards. Move such a
    // occurrence forward by the size of the gap, keeping subsequent days anchored.
    const represented = wall(result, timezone).replace("T", " ");
    if (represented < target) {
        const gap = Date.parse(target.replace(" ", "T") + "Z") - Date.parse(represented.replace(" ", "T") + "Z");
        result = new Date(Date.parse(result.replace(" ", "T")) + gap).toISOString();
    }

    return new Date(result.replace(" ", "T")).toISOString();
}

function nextDate(previous, frequency, anchor, timezone, interval, day, weekdays, month) {
    if (frequency === "weekly" || frequency === "yearly")
        return firstFuture(previous, frequency, anchor, timezone, Date.parse(previous), interval, day, weekdays, month);
    return instant(advance(wall(previous, timezone), frequency, anchor, 1, interval || 1, day || 0), timezone);
}

function nextWeekly(anchor, timezone, threshold, interval, weekdays) {
    const start = new Date(anchor + "Z");
    const anchorDay = start.getUTCDay() || 7;
    const days = weekdays && weekdays.length ? weekdays.slice().sort((a, b) => a - b) : [anchorDay];
    start.setUTCDate(start.getUTCDate() - anchorDay + 1);
    start.setUTCHours(0, 0, 0, 0);
    const current = new Date(wall(new Date(threshold).toISOString(), timezone) + "Z");
    const step = interval * 7 * 86400000;
    let period = Math.max(0, Math.floor((current.getTime() - start.getTime()) / step));
    // Weeks start on Monday and remain phased to the original entry's week.
    for (;;) {
        for (const day of days) {
            const date = new Date(start.getTime() + period * step + (day - 1) * 86400000);
            const next = instant(date.toISOString().slice(0, 10) + " " + anchor.slice(11, 19), timezone);
            if (Date.parse(next) > threshold) return next;
        }

        period++;
    }
}

// Start or change a schedule with its next future occurrence. This avoids
// recreating history when an old transaction is enabled or a paused schedule resumes.
function firstFuture(previous, frequency, anchor, timezone, now, interval, day, weekdays, month) {
    interval = interval || 1;
    day = day || 0;
    const threshold = Math.max(now, Date.parse(previous));
    if (frequency === "weekly") return nextWeekly(anchor, timezone, threshold, interval, weekdays);
    const date = new Date(anchor + "Z");
    const current = new Date(wall(new Date(threshold).toISOString(), timezone) + "Z");
    let periods = 0;
    if (frequency === "daily") {
        const days = interval;
        periods = Math.max(1, Math.floor((current.getTime() - date.getTime()) / (days * 86400000)));
    } else if (frequency === "yearly") {
        periods = Math.max(0, Math.floor((current.getUTCFullYear() - date.getUTCFullYear()) / interval));
    } else {
        const months = (current.getUTCFullYear() - date.getUTCFullYear()) * 12 + current.getUTCMonth() - date.getUTCMonth();
        const step = interval * (frequency === "monthly" ? 1 : 12);
        // A chosen monthly day can still fall later in the original month.
        periods = Math.max(frequency === "monthly" && day ? 0 : 1, Math.floor(months / step));
    }

    let next;
    do {
        next = instant(advance(anchor, frequency, anchor, periods++, interval, day, month), timezone);
    } while (Date.parse(next) <= threshold);

    return next;
}

function configure(record, app, user) {
    const frequency = record.getString("recurrence");
    const kind = record.getString("kind");
    if (["expense", "income"].indexOf(kind) < 0) throw new BadRequestError("Choose expense or income.");
    if (frequency && frequencies.indexOf(frequency) < 0)
        throw new BadRequestError("Choose a valid repeat frequency.");
    if (!frequency) {
        managed.forEach((field) => record.set(field, ""));
        record.set("recurrence_interval", 0);
        record.set("recurrence_day", 0);
        record.set("recurrence_weekdays", []);
        record.set("recurrence_month", 0);
        return;
    }

    const interval = record.get("recurrence_interval") || 1;
    const day = record.get("recurrence_day");
    const month = record.getInt("recurrence_month");
    const weekdays = (JSON.parse(record.getString("recurrence_weekdays") || "[]") || []);
    validateInput({ recurrence_weekdays: weekdays, recurrence_month: record.get("recurrence_month") });
    if (!Number.isInteger(interval) || interval < 1 || interval > 365)
        throw new BadRequestError("Repeat intervals must be whole numbers from 1 to 365.");
    if (!Number.isInteger(day) || day < -1 || day > 31 || (["monthly", "yearly"].indexOf(frequency) < 0 && day !== 0))
        throw new BadRequestError("Choose a calendar day from 1 to 31, the original date, or the last day.");
    if ((frequency !== "weekly" && weekdays.length) || (frequency !== "yearly" && month))
        throw new BadRequestError("Weekdays are weekly-only and a month is yearly-only.");
    weekdays.sort((a, b) => a - b);
    record.set("recurrence_weekdays", weekdays);
    record.set("recurrence_interval", interval);
    const original = record.original();
    if (record.isNew() || (original.getString("recurrence_error") && !record.getString("recurrence_error")) || frequency !== original.getString("recurrence") || interval !== original.getInt("recurrence_interval") || day !== original.getInt("recurrence_day") || month !== original.getInt("recurrence_month") || JSON.stringify(weekdays) !== JSON.stringify(JSON.parse(original.getString("recurrence_weekdays") || "[]") || []) || record.getString("occurred_at") !== original.getString("occurred_at")) {
        const timezone = require(`${__hooks}/configuration.js`).preferences(app, user).timezone;
        const anchor = wall(record.getString("occurred_at"), timezone);
        record.set("recurrence_timezone", timezone);
        record.set("recurrence_anchor", anchor);
        record.set("recurrence_next", firstFuture(record.getString("occurred_at"), frequency, anchor, timezone, Date.now(), interval, day, weekdays, month));
        record.set("recurrence_error", "");
    }
}

function generate(app, collection, id, now) {
    app.runInTransaction((tx) => {
        const seed = tx.findRecordById(collection, id);
        if (!seed.getString("recurrence") || seed.getString("recurrence_error")) return;
        let next = seed.getString("recurrence_next");
        for (let count = 0; next && Date.parse(next) <= now && count < 100; count++) {
            let actor, members, before;
            const shared = collection === "circle_expenses";
            if (shared) {
                const service = require(`${__hooks}/circles-service.js`);
                actor = tx.findRecordById("circle_members", seed.getString("created_by"));
                const access = service.access(tx, seed.getString("circle"), actor.getString("user"));
                service.requireExpensePermission(access.circle, access.member, "add");
                members = service.memberRecords(tx, seed.getString("circle"));
                service.memberInCircle(members, seed.getString("paid_by"), []);
                JSON.parse(seed.getString("shares")).forEach((share) => service.memberInCircle(members, share.member, []));
                if (tx.countRecords(collection, $dbx.hashExp({ circle: seed.getString("circle") })) >= 10000) throw new Error("This circle has reached its entry limit.");
                require(`${__hooks}/circle-categories.js`).select(tx, seed.getString("circle"), seed.getString("category"), null, seed.getString("kind"));
                before = service.balances(tx, seed.getString("circle"));
            } else tx.findRecordById("users", seed.getString("user"));
            const copy = new Record(tx.findCollectionByNameOrId(collection));
            const fields = shared ? ["circle", "title", "category", "source", "paid_by", "created_by", "split_mode", "shares", "receipt"] : ["user", "merchant", "category"];
            fields.concat(["kind", "amount", "currency", "notes", "payment_method"]).forEach((field) => copy.set(field, seed.get(field)));
            copy.set("occurred_at", next);
            copy.set("recurrence_weekdays", []);
            if (shared) copy.set("version", 1);
            else copy.set("source", "manual");
            require(`${__hooks}/push.js`).skipAutomation(copy);
            tx.save(copy);
            if (shared) require(`${__hooks}/circles-service.js`).preserveFormerBalances(tx, seed.getString("circle"), members, before);
            next = nextDate(next, seed.getString("recurrence"), seed.getString("recurrence_anchor"), seed.getString("recurrence_timezone"), seed.getInt("recurrence_interval"), seed.getInt("recurrence_day"), (JSON.parse(seed.getString("recurrence_weekdays") || "[]") || []), seed.getInt("recurrence_month"));
        }

        seed.set("recurrence_next", next);
        if (collection === "circle_expenses") seed.set("version", seed.getInt("version") + 1);
        tx.save(seed);
    });
}

function run(app, now) {
    now = now === undefined ? Date.now() : now;
    for (const collection of ["expenses", "circle_expenses"]) {
        const seeds = app.findRecordsByFilter(collection, "recurrence != '' && recurrence_error = '' && recurrence_next <= {:now}", "recurrence_next,id", 100, 0, { now: new Date(now).toISOString() });
        seeds.forEach((seed) => {
            try {
                generate(app, collection, seed.id, now);
            } catch (error) {
                // Re-read inside the transaction: never overwrite a concurrent edit.
                app.runInTransaction((tx) => {
                    let current;
                    try {
                        current = tx.findRecordById(collection, seed.id);
                    } catch {
                        return;
                    }

                    if (current.getString("recurrence_next") !== seed.getString("recurrence_next")) return;
                    current.set("recurrence_error", String(error.message || error).slice(0, 300));
                    if (collection === "circle_expenses") current.set("version", current.getInt("version") + 1);
                    tx.save(current);
                });
            }
        });
    }
}

module.exports = { configure, protect, validateInput, nextDate, firstFuture, run };
