# PocketBase setup

Tested with PocketBase **0.40.6** and an existing `users` auth collection. The iOS app requires backend **45**, which separates income and expense categories for personal and Circle transactions. For iOS alerts, run the [push relay as a separate Docker service](push-relay/README.md). Copy the complete hooks catalog even if there are no new pending migrations.

1. Back up your existing `pb_data` directory and stop PocketBase.
2. Copy all files from `pb_hooks/` and `pb_migrations/` into the directories used by your PocketBase instance. Preserve existing data, unrelated files, and identity-provider settings.
3. Delete the obsolete `pb_hooks/login-keys.pb.js` and `pb_hooks/login-keys.js` files from the installed hooks directory if present. Backend 35 deletes the `login_keys` collection and its stored credentials.
4. Restart PocketBase to apply pending migrations. If automatic migrations are disabled, run `./pocketbase migrate up` with the same directory settings first.
5. Open the matching iOS app and check sign-in and transaction creation.

Use these steps for upgrades too. Keep previously applied migrations and their history intact. Do not run `migrate down` as an uninstall step; some rollback migrations delete data.

Keep `<POCKETBASE_URL>/api/oauth2-redirect` as your identity provider's allowed callback for the Next.js web app. For the native Expenditure iOS app, also allow `dev.tkkr.expenditure://oauth2/callback` on the same provider client. Add the native URL without replacing the web URL or changing the existing client ID/secret. iOS uses direct authorization-code exchange with PKCE so Private Relay does not affect the realtime IP check; the web app keeps its existing browser flow. If you restrict allowed origins, include your frontend URL. Your reverse proxy must support realtime/SSE connections.
