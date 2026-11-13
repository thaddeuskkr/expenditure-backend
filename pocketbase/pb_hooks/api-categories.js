function list(e, explicitCircle) {
    const api = require(`${__hooks}/expenditure.js`);
    const configuration = require(`${__hooks}/configuration.js`);
    const identity = api.authenticate(e, "expenses:read");
    const circle = explicitCircle ? e.request.pathValue("id") : configuration.preferences(e.app, identity.user.id).default_api_circle;
    const kind = configuration.categoryKind(e.request.url.query().get("kind") || undefined);
    let categories;
    if (circle) {
        // API-key identity alone determines membership, even with a user session.
        require(`${__hooks}/circles-service.js`).access(e.app, circle, identity.user.id);
        categories = require(`${__hooks}/circle-categories.js`).list(e.app, circle, kind);
    } else categories = configuration.categories(e.app, identity.user.id, kind);
    api.touch(e.app, identity.key);
    return e.json(200, categories);
}

module.exports = { list };
