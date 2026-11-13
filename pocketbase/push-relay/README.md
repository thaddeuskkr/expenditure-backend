# Circle push relay

Run this as a separate Docker service from PocketBase. It sends Circle activity and optional Shortcut expense alerts through APNs. No npm packages or database are needed.

## Apple key

Enable Push Notifications for `dev.tkkr.Expenditure`, refresh the app’s signing profiles, and [create an APNs key](https://developer.apple.com/help/account/keys/create-a-private-key). For TestFlight/App Store, choose **Production → Topic Specific → dev.tkkr.Expenditure**. Download the `.p8` once and record its Key ID and your Team ID. Keep the key outside the repositories.

New keys are environment-specific. This relay accepts one signing-key configuration: use a Production key for distribution builds or a Sandbox key for development installs. Supporting both with new keys needs separate credential selection. [Apple’s key rules](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

## Start the container

From this directory:

```sh
cp .env.example .env
```

Fill in `.env`: Team ID, Key ID, and the **Docker host paths** of the `.p8` and shared-secret file. Create a shared secret with `openssl rand -hex 32` and save its output in the file named by `RELAY_SECRET_FILE`. Both files are mounted read-only under `/run/secrets`; they are excluded from the image build context.

The service runs as UID/GID 1000 by default. Give that user read access to both files, or set `RELAY_UID`/`RELAY_GID` to the intended host service user. On Linux, file-backed Compose secrets retain host ownership/permissions; setting a secret’s `mode` in Compose does not fix unreadable host files. For example, for UID/GID 1000:

```sh
sudo chown 1000:1000 /opt/expenditure/secrets/production-apns.p8 /opt/expenditure/secrets/relay-secret
sudo chmod 400 /opt/expenditure/secrets/production-apns.p8 /opt/expenditure/secrets/relay-secret
```

Create the shared network once, then build and start:

```sh
docker network create expenditure-push
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
```

Use your chosen network name if you change `PUSH_RELAY_NETWORK`. The external network lets the relay and PocketBase have independent Compose lifecycles. The container runs without root, has a read-only filesystem, and includes an authenticated health check. Host port 8091 is bound only to `127.0.0.1`; `RELAY_PORT` changes that host port. `docker compose logs --tail=100 push-relay` shows startup errors.

## Connect PocketBase

For **PocketBase in another container**, merge this into its existing Compose service and retain its other networks and volume configuration:

```yaml
services:
  pocketbase:
    environment:
      EXPENDITURE_PUSH_RELAY_URL: http://push-relay:8091/send
      EXPENDITURE_PUSH_RELAY_SECRET: ${EXPENDITURE_PUSH_RELAY_SECRET:?Set the same relay secret}
    networks:
      - default
      - expenditure-push

networks:
  expenditure-push:
    external: true
```

Set PocketBase’s `EXPENDITURE_PUSH_RELAY_SECRET` to the contents of the relay’s secret file. Install the complete backend 41 hooks/migrations and recreate the PocketBase container so its environment changes apply. The relay’s network name must match the external network in the PocketBase project.

For **PocketBase running directly on the same host**, use `EXPENDITURE_PUSH_RELAY_URL=http://127.0.0.1:8091/send` instead, with the same secret. If PocketBase is on another machine, connect over a private tunnel or an HTTPS reverse proxy; the default loopback binding does not expose the relay remotely.

## Verify delivery

Install the updated app, sign in and allow notifications. Settings → Notifications has separate Circle and automation choices, applied with Save/Discard. Shortcut alerts start off and notify the account that added the expense. Test with two accounts on an APNs-capable device while the recipient app is closed. Delivery runs every minute and retries temporary failures for up to 24 hours. The health check proves the relay can load its configuration and serve authenticated requests; it does not verify Apple credentials or real APNs delivery.

After changing key or secret file contents, restart the relay with `docker compose restart push-relay`. See the [backend installation guide](../README.md) for PocketBase upgrades.

For direct Node hosting, run `node server.mjs` with Node 22.18+ and `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_KEY_PATH`, `APNS_TOPIC`, plus either `EXPENDITURE_PUSH_RELAY_SECRET` or `EXPENDITURE_PUSH_RELAY_SECRET_FILE`. The default direct-host binding is `127.0.0.1:8091`; `HOST` and `PORT` override it.

The app has two test buttons in **Settings → Notifications**. **Send local test notification** checks iPhone permissions and local alerts. **Send APNs test notification** sends immediately through PocketBase, this relay and Apple to the current iPhone. The app reports Apple acceptance separately from confirmed receipt; acceptance alone does not guarantee arrival. Keep the app open to see receipt confirmation. Both tests leave pending preferences unchanged, including when activity alerts are all off. APNs tests require a device with an APNs token and the correct sandbox/production key configuration. Wait 10 seconds between APNs attempts. Errors identify missing relay configuration, connection/rejection or an invalid token without exposing credentials.
