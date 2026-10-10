# AI OAuth access (server-only)

Explicit Pi 1.0.4 `createModels().login()` bridge; only `openai`, `anthropic`, and `openai-codex` are registered. No default/all-provider registration, ambient credential import, model-policy changes, custom host, or custom refresh implementation.

## Host integration

```ts
import { openAiAccess } from '@sanxing/ai-access';
const access = await openAiAccess({
  directory: '/private/app-data/ai-auth', // separate from learning JSONB and plaintext backups
  secret: process.env.SESSION_SECRET!, // at least 32 characters; keep stable and private
});
const flow = await access.start('anthropic', websiteSession.id, websiteSession.expiresAt);
// Poll access.providers(websiteSession.id); submit the CURRENT input.id, not just a flow id.
await access.submit(flow.id, promptId, answer, websiteSession.id);
// Website logout / eviction:
await access.cancelOwner(websiteSession.id);
// Application shutdown:
await access.close();
```

The host must authenticate/authorize every endpoint, enforce CSRF protections, pass trusted session identifiers and expiry timestamps, and never log submitted codes or credential contents. `disconnect(providerId)` intentionally has no owner argument: authorization of this installation-wide action belongs to the host. Provider metadata is local credential presence/expiry, **not upstream account validation**. An expired credential remains connected and may refresh on model use. Unrepresentable expiry dates become `null`.

`start(providerId, ownerSessionId, ownerExpiresAt?)` caps its default ten-minute TTL at the website session expiry. Expired owners are rejected. Repeated start by the same owner/provider reuses the active flow (never extends its deadline); a different owner/provider receives a generic conflict with no flow data. Flow lookup and submission by another owner return the same 404 as missing flow IDs. Terminal views retain no URL, instructions, input, or submitted code, and there is at most one record per provider.

Every login has a separate Models instance, provider instance, and temporary InMemoryCredentialStore. Only an eligible successful result is copied into the persistent store. Start, cancellation, disconnect, owner logout, and commit share one queue. Once persistence has started under that queue it is ordered before a subsequent cancellation; cancellation does not pretend to roll back successful authorization. Disconnect is ordered after that commit and removes the credential. Abort/expiry clears prompts and timers without waiting for an uncooperative provider. SDK work already in progress cannot be force-killed; its late result cannot commit.

## Provider behavior

- **OpenAI** uses `127.0.0.1:1455`, an encrypted persisted installation UUID, and requires the complete final callback URL for manual input (including code, state, issued client ID). Its credentials are not interchangeable with Codex.
- **Anthropic** forwards the SDK's browser/copy_code selector unchanged. copy_code uses no local callback port and is suitable for WSL.
- **Codex** forwards browser/device_code selection. Device codes show the verification URI and user code, not a fabricated input prompt.
- Authorization never switches mock/live mode or the selected model. OAuth does not imply free use. Pi's OpenAI and Codex request paths omit upstream `max_output_tokens`, so neither promises a hard upstream output cap.
- AuthContext refuses env/file reads. Login also rejects ambient `OPENAI_*`, `ANTHROPIC_*`, `PI_OAUTH_*`, proxy and TLS overrides rather than changing `process.env`. URLs are HTTPS-only, without userinfo/custom ports, and allow only the provider's actual official authorization hosts. No arbitrary provider error/info/progress response text is exposed.

## Vault and refresh

`openCredentialVault()` creates/chmods its independent directory to 0700 and holds `@sanxing/local-storage`'s cross-process directory lock until close. `credentials.enc` is 0600, AES-256-GCM authenticated encryption with random 96-bit nonce and a purpose-separated HKDF-SHA256 key derived from SESSION_SECRET. Installation UUID and complete OAuth credentials (including extension fields such as clientId/scopes/accountId) are encrypted together. Writes use an exclusive 0600 temporary file, file fsync, and atomic rename; failures preserve the prior in-memory state. Bad ciphertext, wrong keys and invalid payloads fail closed without reset. Do not delete a locked vault or rotate SESSION_SECRET without a deliberate credential migration/re-authorization plan.

All store operations are serialized; the *entire awaited* modify callback owns the queue. `undefined` means unchanged, never deletion. Reads and returned mutations are deep copies. Abort is checked before entering a queued operation, not after refresh starts, so a rotated token is not discarded. Close refuses new operations and drains accepted operations before releasing its lock. SDK `getAuth`/stream paths own automatic refresh; use `access.credentials` in the host's Models instance rather than implementing refresh or copying tokens yourself. Directory ownership coordinates cooperating processes on a local filesystem; no distributed lock, key rotation, secure deletion, or hardware-backed key storage is claimed. Atomic replacement uses fsync on the file, not a directory-fsync durability guarantee.

## Offline verification

```sh
npm exec vitest -- run packages/ai-access
npm run check
```

Workspace links and dependencies are installed from the repository root. Tests use same-ID fake `Provider.auth.oauth` implementations through real Pi Models.login and never call real OAuth/model endpoints. Real provider consent, port availability, and external token refresh remain integration limitations; the host must provide a local trusted runtime with no ambient network reconfiguration. No browser DTO contains access/refresh tokens.
