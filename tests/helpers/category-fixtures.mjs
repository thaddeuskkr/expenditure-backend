// Human-readable fixture labels are resolved before session writes. Product
// session APIs accept IDs only; automation requests deliberately bypass this helper.
export async function resolveCategoryFixture(base, path, body, token) {
    const url = new URL(path, base);
    const native = url.pathname.match(/^\/api\/collections\/(expenses|budgets|circle_expenses)\/records(?:\/[^/]+)?$/);
    const circle = url.pathname.match(/^\/api\/expenditure\/circles\/([a-z0-9]{15})\/expenses(?:\/[^/]+)?(?:\/move-to-personal)?$/);
    const feed = url.pathname === "/api/expenditure/transactions";
    if (!native && !circle && !feed) return { path, body };
    if (native) url.searchParams.set("expand", "category");
    const personal = !circle || url.pathname.endsWith("/move-to-personal");
    const needsCategory = typeof body?.category === "string" || url.searchParams.has("category") || /category\s*(=|!=)/.test(url.searchParams.get("filter") || "");
    if (needsCategory && token) {
        const headers = { Authorization: token };
        let categories;
        if (!personal) {
            const response = await fetch(`${base}/api/expenditure/circles/${circle[1]}`, { headers });
            if (response.ok) categories = (await response.json()).categories;
        } else if (body?.user) {
            const response = await fetch(`${base}/api/collections/categories/records?perPage=100&filter=${encodeURIComponent(`user = '${body.user}'`)}`, { headers });
            if (response.ok) categories = (await response.json()).items;
            if (!categories?.length) {
                const configuration = await fetch(`${base}/api/expenditure/config`, { headers });
                if (configuration.ok) categories = (await configuration.json()).categories;
            }
        } else {
            const response = await fetch(`${base}/api/expenditure/config`, { headers });
            if (response.ok) categories = (await response.json()).categories;
        }

        const resolve = (name) => categories?.find((item) => item.kind === (body?.kind || "expense") && item.name.toLowerCase() === name.trim().toLowerCase())?.id || name;
        if (typeof body?.category === "string") body = { ...body, category: native?.[1] === "budgets" && body.category === "Overall" ? "" : resolve(body.category) };
        if (url.searchParams.has("category")) {
            const name = url.searchParams.get("category");
            url.searchParams.set("category", resolve(name) === "Other" && feed ? "unmapped" : resolve(name));
        }

        if (url.searchParams.has("filter")) url.searchParams.set("filter", url.searchParams.get("filter").replace(/(category\s*(?:=|!=)\s*)['"]([^'"]+)['"]/g, (_, prefix, name) => `${prefix}'${resolve(name)}'`));
    }

    return { path: url.pathname + url.search, body };
}
