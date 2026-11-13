import { readFileSync } from "node:fs";

export function readRelaySecret(environment = process.env) {
    const value = environment.EXPENDITURE_PUSH_RELAY_SECRET;
    const file = environment.EXPENDITURE_PUSH_RELAY_SECRET_FILE;
    if (value && file) throw new Error("Set only one relay secret source: EXPENDITURE_PUSH_RELAY_SECRET or EXPENDITURE_PUSH_RELAY_SECRET_FILE.");
    const secret = file ? readFileSync(file, "utf8").trim() : value;
    if (typeof secret !== "string" || secret.length < 32)
        throw new Error("Set a relay secret of at least 32 characters, using EXPENDITURE_PUSH_RELAY_SECRET or EXPENDITURE_PUSH_RELAY_SECRET_FILE.");
    return secret;
}

export function readConfiguration(environment = process.env) {
    for (const name of ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_KEY_PATH", "APNS_TOPIC"]) {
        if (!environment[name]) throw new Error(`Set ${name}.`);
    }

    const port = Number(environment.PORT ?? 8091);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
    return {
        teamID: environment.APNS_TEAM_ID,
        keyID: environment.APNS_KEY_ID,
        topic: environment.APNS_TOPIC,
        privateKey: readFileSync(environment.APNS_KEY_PATH),
        secret: readRelaySecret(environment),
        host: environment.HOST ?? "127.0.0.1",
        port,
    };
}
