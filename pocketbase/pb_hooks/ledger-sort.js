// Only these named orders reach SQL; request strings are never interpolated.
function parse(query, name) {
    const value = query.get(name) || "date_desc";
    if (!["date_desc", "date_asc", "amount_desc", "amount_asc"].includes(value))
        throw new BadRequestError("Choose a valid transaction sort order.");
    return value;
}

function order(sort, amount, currency, tieBreakers) {
    const chronological = sort === "date_asc" ? "ASC" : "DESC";
    const dates = tieBreakers.map((field) => `${field} ${chronological}`);
    if (!sort.startsWith("amount_")) return dates;
    // Compare displayed currency units using integers, not raw minor units or
    // exchange-rate estimates. The currency filter can restrict comparisons.
    const catalog = require(`${__hooks}/currencies.json`);
    const scale = [0, 3].map((digits) => {
        const codes = catalog.filter((item) => item.digits === digits).map((item) => `'${item.code}'`).join(",");
        return codes ? `WHEN ${currency} IN (${codes}) THEN ${Math.pow(10, 3 - digits)}` : "";
    }).filter(Boolean).join(" ");
    return [`(${amount} * CASE ${scale} ELSE 10 END) ${sort === "amount_asc" ? "ASC" : "DESC"}`, ...dates];
}

module.exports = { parse, order };
