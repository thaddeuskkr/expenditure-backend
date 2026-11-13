function timestamp(value) {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
        ) ||
        !isFinite(Date.parse(value))
    )
        throw new BadRequestError("Use an ISO date with a timezone.");
    const local = value.slice(0, 16) + ":" + (value.match(/T\d{2}:\d{2}:(\d{2})/) || ["", "00"])[1];
    if (
        !isFinite(Date.parse(local + "Z")) ||
        new Date(local + "Z").toISOString().slice(0, 19) !== local
    )
        throw new BadRequestError("Choose a valid calendar date.");
    return new Date(value).toISOString();
}

function bounds(query) {
    const from = query.get("from"),
        to = query.get("to"),
        previous = query.get("previous");
    const fromDate = new Date(from),
        toDate = new Date(to),
        previousDate = new Date(previous);
    if (
        !from ||
        !to ||
        !previous ||
        !isFinite(fromDate.getTime()) ||
        !isFinite(toDate.getTime()) ||
        !isFinite(previousDate.getTime()) ||
        toDate <= fromDate ||
        fromDate <= previousDate ||
        toDate - previousDate > 64 * 86400000
    )
        throw new BadRequestError("Provide a valid monthly date range.");
    const currency = query.get("currency") || "all";
    if (
        currency !== "all" &&
        !require(`${__hooks}/configuration.js`).currency(currency)
    )
        throw new BadRequestError("Unsupported currency.");
    // Match PocketBase's normalized date representation for indexed comparisons.
    function pbDate(date) {
        return date.toISOString().replace("T", " ");
    }

    return {
        from: pbDate(fromDate),
        to: pbDate(toDate),
        previous: pbDate(previousDate),
        currency,
    };
}

module.exports = { timestamp, bounds };
