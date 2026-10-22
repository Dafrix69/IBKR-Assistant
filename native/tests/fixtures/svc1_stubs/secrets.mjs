export function secretExists(service, account) { return globalThis.__svc1.secret('exists', service, account); }
export function readSecret(service, account) { return globalThis.__svc1.secret('read', service, account); }
export function writeSecret(service, account, secret) { return globalThis.__svc1.secret('write', service, account, secret); }
