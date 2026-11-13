# PocketBase setup

Expenditure on iOS requires backend **46**. This backend is tested with PocketBase **0.40.6** and its `users` auth collection.

1. Back up `pb_data` and stop PocketBase.
2. Copy `pb_hooks/` and `pb_migrations/` into the directories used by your instance. Keep previously applied migrations and identity-provider settings.
3. Remove any installed copies of `login-keys.pb.js`, `login-keys.js`, `api-categories.js`, `api-transactions.js`, and `expenditure.js` from the hooks directory. Install the updated `main.pb.js` and `circles.pb.js` to remove the retired routes.
4. Restart PocketBase to apply pending migrations. If automatic migrations are disabled, run `./pocketbase migrate up` with the same directory settings before restarting.
5. Open the matching iOS app and check sign-in and transaction creation. Remove the old web deployment separately if it is still hosted.

Version 46 deletes integration keys and retry records. Transactions previously imported with keys appear as **Shortcut** transactions. Restore the backup and its matching hooks if you need to roll back.

For native OAuth, register `dev.tkkr.expenditure://oauth2/callback` with your identity provider. Keep the provider client ID and secret configured in PocketBase. The iOS app uses a direct authorization-code exchange with PKCE. Your reverse proxy must support realtime connections.

For iOS alerts, update and run the [push relay](push-relay/README.md).
