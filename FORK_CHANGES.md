# Fork Changes (Johnson-Law-Group/LibreChat)

This document tracks the customizations our fork carries on top of the upstream
[danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) project.
Keep this file updated whenever a new fork-only change lands or whenever we
merge a new upstream release that touches one of the files below.

## How to read this doc

- **What** — short description of the change
- **Where** — files / functions touched
- **Why** — the business or operational reason we made it
- **Upstream risk** — how the change is likely to conflict on the next merge,
  and what to watch for when resolving

## Upstream baseline

Last upstream merge: **`v0.8.6-rc1`** (merged 2026-05-18 onto branch
`merge-upstream-v0.8.6-rc1`).

Previous baseline before that merge was upstream commit `5cc783b8e` (Apr 2025).

## Customizations

### 1. Azure Blob Storage — full feature set

**What.** Comprehensive support for using Azure Blob Storage as the file
backend, including SAS-token generation, expiry checks, automatic refresh of
avatar URLs, and a static-route proxy so that the frontend never has to deal
with expiring URLs directly.

**Where.**
- [api/server/services/Files/Azure/crud.js](api/server/services/Files/Azure/crud.js)
  — adds `generateAzureSasUrl`, `needsAzureRefresh`,
  `extractBlobPathFromAzureUrl`, `getNewAzureURL`. `AZURE_SAS_EXPIRY_SECONDS`
  env var (default 1 hour, max 7 days). `saveBufferToAzure` returns a SAS URL
  for private containers. `getAzureFileStream` now accepts blob paths (not
  just full URLs) and streams blobs via the Azure SDK instead of axios.
- [api/server/services/Files/Azure/images.js](api/server/services/Files/Azure/images.js)
  — `uploadImageToAzure` stores the blob path (e.g. `images/{userId}/{file}`)
  in the file record instead of the raw SAS URL. `prepareAzureImageURL`
  returns the path with a leading slash so the frontend hits our proxy route.
- [api/server/services/Files/process.js](api/server/services/Files/process.js)
  — `saveBase64Image` rewrites the SAS URL returned by `saveBuffer` to the
  relative `images/{userId}/{filename}` path when the strategy is
  `azure_blob`. This sits *next to* upstream's new `getStorageMetadata` call,
  which is orthogonal (metadata only applies to s3/cloudfront).
- [api/server/services/Files/images/encode.js](api/server/services/Files/images/encode.js)
  — re-throws errors when blob-storage image conversion fails instead of
  silently swallowing them.
- [api/server/routes/static.js](api/server/routes/static.js) — new Express
  middleware that, when `CDN_PROVIDER === azure_blob`, streams the blob from
  Azure directly to the client (sets correct `Content-Type`, long
  `Cache-Control`). Falls through to the regular static handler on any error.
- [api/server/controllers/UserController.js](api/server/controllers/UserController.js)
  — `getUserController` refreshes a user's Azure avatar URL when the existing
  SAS token is within 1 hour of expiry. Mirrors the existing S3 refresh path.

**Why.** Upstream's Azure support saved full SAS URLs into the database. SAS
tokens expire (default 1 hour), so on long-lived records (avatars, generated
images) the URLs would 403 and break the UI. The fix is to store the
*relative* blob path instead and proxy reads through the backend, generating
a fresh SAS on demand. Avatars are stored in the DB and can't easily be
rewritten on every fetch, so they get an explicit refresh-and-persist path.

**Upstream risk.**
- File/storage strategy refactors hit `process.js`, `images.js`, and `crud.js`
  fairly often. Watch for changes to `saveBuffer` return contracts or new
  storage strategies — our azure_blob conditional may need to move with them.
- Upstream is moving toward a `getStorageMetadata` abstraction (introduced in
  v0.8.6-rc1). If upstream extends this to azure, we may be able to delete
  our `process.js` patch.

### 2. Custom-endpoint header & user-tracking enhancements

**What.** When initializing a custom endpoint:
1. Run `resolveHeaders` over `customOptions.headers` so admins can put
   templates like `{{LIBRECHAT_USER_EMAIL}}` (or anything `req.user` /
   `req.body` exposes) directly into the YAML config.
2. Pass the user's email (falling back to userId) as the `user` field in
   `modelOptions`, so vendor dashboards (e.g. OpenRouter) attribute usage to
   the actual human instead of an opaque MongoDB ObjectID.

**Where.** [packages/api/src/endpoints/custom/initialize.ts](packages/api/src/endpoints/custom/initialize.ts)
— inside `initializeCustom`.

**Why.** Operationally we want vendor-side per-user usage attribution, and we
need to pass auth/identity headers (signed by us) to downstream model
proxies. Doing it at init-time means it works for every custom endpoint
without per-endpoint plumbing.

**Upstream risk.** `initialize.ts` is regularly refactored as upstream
restructures their endpoint pipeline. Each merge should re-verify the
`resolveHeaders` call still has access to `req.body` and `req.user`, and that
`modelOptions.user` is still the right place to inject the identifier.

### 3. MCP servers — config-time env resolution

**What.** `MCPServersRegistry` now runs `processMCPEnv` over the server
options before passing them to `MCPServerInspector.inspect`, in all three
call-sites: `addServer`, `reinspectServer`, and `lazyInitConfigServer`.

**Where.** [packages/api/src/mcp/registry/MCPServersRegistry.ts](packages/api/src/mcp/registry/MCPServersRegistry.ts)
— diff is small (one `const resolvedConfig = processMCPEnv(...)` before each
`inspect` call).

**Why.** Without this, MCP server configs that reference env vars (e.g.
`"command": "${MCP_PROXY_BIN}"`) would be passed to the inspector verbatim and
fail. Resolving at registry layer means YAML-sourced and DB-sourced configs
both benefit, and individual MCP transports don't each need to re-implement
env interpolation.

**Upstream risk.** Upstream is in active flux on MCP — they recently added
`allowedAddresses` as a new `inspect` parameter (preserved in this merge).
Watch for further inspector-signature changes; our wrapping is purely
additive at the call-site, so conflicts here are usually simple.

### 4. ModelSpec label prioritization in chat UI

**What.** When a conversation has a `spec`, the spec's `label` is used as the
display name across every chat-message and conversation chrome surface,
overriding assistant/agent/model names.

**Where.**
- [client/src/components/Chat/Messages/MessageParts.tsx](client/src/components/Chat/Messages/MessageParts.tsx)
- [client/src/components/Chat/Landing.tsx](client/src/components/Chat/Landing.tsx)
- [client/src/components/Chat/Input/AddedConvo.tsx](client/src/components/Chat/Input/AddedConvo.tsx)
- [client/src/components/Endpoints/ConvoIcon.tsx](client/src/components/Endpoints/ConvoIcon.tsx)
- [client/src/components/Share/MessageIcon.tsx](client/src/components/Share/MessageIcon.tsx)
- [client/src/hooks/Input/useTextarea.ts](client/src/hooks/Input/useTextarea.ts)
- [client/src/hooks/Messages/useMessageActions.tsx](client/src/hooks/Messages/useMessageActions.tsx)

**Why.** We expose curated model specs to end users (e.g. "Litigation
Drafting") rather than raw vendor model IDs. The spec label is the canonical
human-readable name; not honoring it makes the UI inconsistent between the
selector dropdown and the conversation view.

**Upstream risk.** Any upstream refactor of how message titles / icons are
resolved (rename of `getModelSpec`, `conversation.spec`, or `startupConfig`)
will conflict. Conflict resolution is normally a one-liner — re-apply the
"specLabel comes first" branch.

### 5. Custom-endpoint response sender — model name fallback

**What.** In `getResponseSender`, when no `chatGptLabel` / `modelLabel` /
`modelDisplayLabel` is set, fall through to `model` (the raw model ID)
instead of running through a long ladder of hardcoded vendor branches
(Mistral, Deepseek, Kimi, Moonshot, GPT-x, omni-version extraction).

**Where.** [packages/data-provider/src/parsers.ts](packages/data-provider/src/parsers.ts).

**Why.** Our deployment routes most traffic through OpenRouter / custom
endpoints. The upstream hardcoded brand-name fallback ("Mistral", "GPT",
etc.) misclassifies our models and erases the precise model ID that
operators want to see. Falling back to the actual model name is both more
accurate and more useful.

**Upstream risk.** Low — upstream very rarely touches this function, but
when they do, our simplification is easy to re-apply (delete their vendor
ladder, drop in the `else if (model) { return model; }` branch).

### 6. Chat avatar / heading visual tweaks

**What.**
- Message avatars rendered at **`h-10 w-10`** instead of `h-6 w-6`.
- Message headings use **`font-bold`** instead of `font-semibold`.
- Icon components (`MessageIcon`, `MessageEndpointIcon`, `Icon`,
  `ConvoIconURL`) propagate the explicit `size` prop / `width`/`height`
  styles instead of relying on fixed `h-9 w-9` / `h-6 w-6` classes, so the
  larger avatar size doesn't get clipped.

**Where.**
- [client/src/components/Messages/ContentRender.tsx](client/src/components/Messages/ContentRender.tsx)
- [client/src/components/Chat/Messages/ui/MessageRender.tsx](client/src/components/Chat/Messages/ui/MessageRender.tsx)
- [client/src/components/Chat/Messages/MessageIcon.tsx](client/src/components/Chat/Messages/MessageIcon.tsx)
- [client/src/components/Endpoints/MessageEndpointIcon.tsx](client/src/components/Endpoints/MessageEndpointIcon.tsx)
- [client/src/components/Endpoints/Icon.tsx](client/src/components/Endpoints/Icon.tsx)
- [client/src/components/Endpoints/ConvoIconURL.tsx](client/src/components/Endpoints/ConvoIconURL.tsx)

**Why.** Design choice — at our default font size the upstream 24px avatars
read as too small relative to the message body, and the heading weight was
hard to scan in monospace-heavy legal text.

**Upstream risk.** Low — visual classes are easy to spot in conflicts and
easy to re-apply.

### 7. CI workflow gates (upstream-only jobs)

**What.** Four upstream workflows that fire on `push` to `main` require
secrets / infrastructure that only `danny-avila/LibreChat` has. We gate them
with `if: github.repository == 'danny-avila/LibreChat'` so they cleanly
*skip* on our fork instead of failing red.

**Where.**
- [.github/workflows/dev-images.yml](.github/workflows/dev-images.yml) — needs
  `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` to publish `librechat-dev` images.
- [.github/workflows/locize-i18n-sync.yml](.github/workflows/locize-i18n-sync.yml)
  — needs `LOCIZE_API_KEY` / `LOCIZE_PROJECT_ID` for the upstream-managed
  translation service.
- [.github/workflows/gitnexus-index.yml](.github/workflows/gitnexus-index.yml)
  and [.github/workflows/gitnexus-deploy.yml](.github/workflows/gitnexus-deploy.yml)
  — upstream-internal AI-context indexing pipeline.

Only the *entry* jobs are gated; dependent jobs (`create-pull-request`,
`post-index`, `deploy`) cascade-skip via `needs:`.

**Why.** Failing CI jobs make it impossible to spot real regressions in the
status dashboard. Skipping is the right semantic — these workflows aren't
applicable to our deployment.

**Upstream risk.** Low. On future upstream merges:
- New jobs added to any of these workflows need the same gate.
- If upstream adds any new push-triggered workflow that needs their secrets,
  it'll start failing on our fork — gate it the same way.
- If we ever want to publish our own Docker images / manage our own
  translation pipeline, flip the gate (remove it for `dev-images.yml` and
  set the corresponding fork-side secrets).

## Process for the next upstream merge

1. Create a branch `merge-upstream-<tag>` off `main`.
2. `git fetch upstream --tags && git merge <tag>`.
3. For every file listed in this doc, verify the customization survived the
   auto-merge. The handy check is:
   ```sh
   grep -n 'needsAzureRefresh\|resolveHeaders\|processMCPEnv\|specLabel\|h-10 w-10\|font-bold' <file>
   ```
4. Re-read this doc top-to-bottom and update the affected sections if any of
   the touched files moved, were renamed, or had their surrounding context
   meaningfully change.
5. Run `npm run smart-reinstall` and `npm run frontend` to verify the build,
   then exercise at least one Azure upload, one custom-endpoint call, and
   one modelSpec-backed conversation manually before merging.

## Files we own end-to-end (no upstream contribution expected)

- `api/server/services/Files/Azure/crud.js` — large rewrite. Conflicts will
  be at the *function-addition* level; review carefully.
- `api/server/routes/static.js` — small file, our azure middleware is fully
  additive.

## Files most likely to conflict on a typical merge

Ranked by historical conflict frequency:

1. `packages/api/src/endpoints/custom/initialize.ts`
2. `api/server/services/Files/process.js`
3. `packages/api/src/mcp/registry/MCPServersRegistry.ts`
4. `client/src/components/Chat/Messages/MessageParts.tsx` (and sibling
   icon/title files)
5. `packages/data-provider/src/parsers.ts`
