import { readRelaySecret } from "./configuration.mjs";

try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8091}/healthz`, {
        headers: { Authorization: `Bearer ${readRelaySecret()}` },
        signal: AbortSignal.timeout(2000),
    });
    process.exit(response.status === 200 ? 0 : 1);
} catch {
    process.exit(1);
}
