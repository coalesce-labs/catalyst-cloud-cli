# Replacing an AI account's credential

When the script prints "<provider> account <slot> needs a new credential" (quarantined, expired, revoked, or three or more polls failed on the credential), replace that account's credential on its own page. Do not enroll a second account. It would be a duplicate beside the dead one. No command replaces a credential yet, so a workspace owner or admin does it in the browser, from the link the script prints; the person copies and pastes the credential, and you never read, print or paste it.

## The steps

For an API key, billed per token by its provider:

1. The person creates a new key in the provider's console, under the same provider account the AI account was made from.
2. In the browser, they open Settings → AI accounts, then that account.
3. They paste the new key into the replacement field and press Replace credential.
4. Once the account reads healthy, they can revoke the old key in the provider's console if nothing else uses it.

If the account's page asks for something other than a key, follow the steps the page shows. When the page names the login the account belongs to, the new credential must come from that same login: one from another login would put a live account onto the wrong record. If a tool on the person's machine mints the credential, have them confirm it is signed in to the login the page names before minting; such tools mint for whoever is signed in, not for the account. When the page says Catalyst takes over the login, say so before the paste, and that the person signs in again locally afterwards.

A cancelled or ended account is not a credential problem, and no new credential revives it.

## Afterwards

Replace credential also clears the quarantine; no operator is needed. Run `node scripts/where-am-i.mjs` again. A failed poll stays on record until the next poll, so if the script still names the account, wait for that poll before reporting a disagreement.
