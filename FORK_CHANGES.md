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

Last upstream merge: **`v0.8.6`** (merged 2026-06-05 onto branch
`merge-upstream-v0.8.6`).

Previous baselines:
- `v0.8.6-rc1` (merged 2026-05-18 onto branch `merge-upstream-v0.8.6-rc1`)
- `5cc783b8e` (Apr 2025)

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

### 7. ModelSpec list — additive merge across config overrides

**What.** Add `'modelSpecs.list': 'name'` to `ARRAY_MERGE_KEYS` so that
multiple matching config-override docs (public + group memberships) UNION
their `modelSpecs.list` entries instead of the last config wholesale-replacing
all prior ones. Upstream merges arrays by replacement (line 126,
`result[key] = sourceVal`); only `endpoints.custom` was previously
allowlisted as merge-by-key.

**Where.**
- [packages/data-schemas/src/app/resolution.ts](packages/data-schemas/src/app/resolution.ts)
  — `ARRAY_MERGE_KEYS` constant. Adds `'modelSpecs.list': 'name'` alongside
  the existing `'endpoints.custom': 'name'` entry.
- [packages/data-schemas/src/app/resolution.spec.ts](packages/data-schemas/src/app/resolution.spec.ts)
  — new test case `merges modelSpecs.list arrays by name across multiple
  group overrides` documenting the expected union behavior.

**Why.** Our deployment uses per-principal config overrides (`public`, plus
several `group` principals like `power-users`, `dev-users`,
`client-portal-users`) to gate which modelSpecs each user sees. Upstream's
wholesale-replace semantics meant that a user in multiple groups only ever
saw the last-merged group's list — strictly determined by `priority` ASC then
`_id` ASC. With same-priority groups, only one group's specs would ever
surface, defeating the point of multi-group membership for spec visibility.
Adding `modelSpecs.list` to `ARRAY_MERGE_KEYS` lets each group contribute its
own extras and have them all stack additively, with `mergeArrayByKey`
deduping by spec `name` so the same spec showing up in multiple groups
doesn't multiply.

**Upstream risk.** Low. The `ARRAY_MERGE_KEYS` map is a stable extension
point (it exists specifically to allowlist additional paths). Upstream adding
new entries won't conflict; renaming the map or restructuring the deep-merge
path is the only thing that would.

### 8. CI workflow gates (upstream-only jobs)

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

### 9. JLG custom RAG / File Search integration

**What.** We back LibreChat's File Search with our **own** RAG API (the JLG
backend FastAPI `/rag` router, pointed at by `RAG_API_URL`) instead of the
stock `rag_api` service, and add three behaviors around document uploads:

- **(a) Size-based full-context routing.** `createContextHandlers` decides
  *per file* whether to feed the whole document as context vs. top-K
  retrieval, based on the file's page count (fetched from our API via
  `GET /documents/{id}/pages`) and `RAG_FULL_CONTEXT_MAX_PAGES` (default 30).
  Short docs → `GET /documents/{id}/context` (full text); long docs →
  `POST /query`. Context formatting is shape-based (a string response = full
  context, an array = retrieval pairs) so one conversation can mix both. This
  replaces upstream's single global `RAG_USE_FULL_CONTEXT` env flag.
- **(b) `interface.providerFileUpload` flag.** New interface boolean (default
  `true`) that hides the base "Upload to Provider" / "Upload Image" attach
  option, steering document uploads to File Search (RAG). Upstream has no
  toggle for this item — it's otherwise gated only by
  `isDocumentSupportedProvider`.
- **(c) Provider-upload page-count gate.** A direct "Upload to Provider" PDF
  over `MAX_PROVIDER_UPLOAD_PAGES` (default 20) is rejected with a message
  steering the user to File Search. File Search / context / code uploads
  (which carry a `tool_resource`) are exempt — large docs are what File Search
  is for. The message is allowlisted so it reaches the user verbatim instead
  of the generic "Error processing file". The gate is scoped to PDFs only
  (page count comes from `pdfjs`); other formats are not checked. Note it
  also fires on the assistants-endpoint path (`processFileUpload`), so an
  assistant PDF attachment over the limit with no `tool_resource` is blocked
  the same way.

**Where.**
- (a) [api/app/clients/prompts/createContextHandlers.js](api/app/clients/prompts/createContextHandlers.js)
  — per-file `query()` routing (`getPageCount` → `/context` vs `/query`) and
  shape-based context formatting; `RAG_FULL_CONTEXT_MAX_PAGES`.
- (b) [packages/data-provider/src/config.ts](packages/data-provider/src/config.ts)
  — `providerFileUpload` field in `interfaceSchema` + `true` in its defaults;
  [packages/data-schemas/src/app/interface.ts](packages/data-schemas/src/app/interface.ts)
  — `loadDefaultInterface` passes it through to startupConfig;
  [client/src/components/Chat/Input/Files/AttachFileMenu.tsx](client/src/components/Chat/Input/Files/AttachFileMenu.tsx)
  and [client/src/components/Chat/Input/Files/DragDropModal.tsx](client/src/components/Chat/Input/Files/DragDropModal.tsx)
  — gate the base provider/image-upload `items.push` on
  `startupConfig?.interface?.providerFileUpload !== false`.
- (c) [api/server/services/Files/process.js](api/server/services/Files/process.js)
  — `getPdfPageCount` (inline pdfjs) + `assertProviderUploadWithinPageLimit`,
  called early in both `processFileUpload` and `processAgentFileUpload`;
  `MAX_PROVIDER_UPLOAD_PAGES`.
  [packages/api/src/utils/files.ts](packages/api/src/utils/files.ts) — added
  `'must be uploaded with File Search'` to `USER_FACING_UPLOAD_ERRORS` so the
  gate's message is surfaced to the user.
- (d) [client/src/hooks/Files/useFileHandling.ts](client/src/hooks/Files/useFileHandling.ts)
  — upload/validation error toast `duration` raised from 5000 to 10000 ms in
  `displayToast`, so the page-gate message (and other upload errors) stays
  readable long enough to act on.

**Why.** Users were uploading scanned medical-record PDFs via "Upload to
Provider," which sends raw page images to the model on every turn (200k–350k
image tokens/request). We route documents through a RAG API we control (OCR +
pgvector retrieval on the JLG backend). The `providerFileUpload` flag and the
page gate steer users off the expensive direct-upload path onto File Search;
the size-based routing gives small docs full-text fidelity while large docs
use retrieval. `RAG_API_URL` must point at the backend (`jlg-ai-backend-{env}`
+ `/rag`); the backend validates LibreChat's short-lived JWT (signed with the
shared `JWT_SECRET`) against its `LIBRECHAT_JWT_SECRET`.

**New env vars.** `RAG_FULL_CONTEXT_MAX_PAGES` (default 30),
`MAX_PROVIDER_UPLOAD_PAGES` (default 20), and the existing `RAG_API_URL`.

**Upstream risk.**
- `process.js` is high-churn (already #2 below). Our change is two early calls
  + two module-level helpers — re-apply at the top of `processFileUpload` /
  `processAgentFileUpload`.
- `createContextHandlers.js`: upstream may rework the RAG/context flow or the
  `RAG_USE_FULL_CONTEXT` handling we replaced. Re-apply the per-file routing +
  shape-based formatting.
- `interface` schema/loader additions are additive; risk is an upstream
  restructure of `interfaceSchema` / `loadDefaultInterface` (re-add the field
  + passthrough). The AttachFileMenu/DragDropModal gate is a small conditional
  around the base-upload `items.push`.
- `USER_FACING_UPLOAD_ERRORS` is a stable allowlist; keep the
  `'must be uploaded with File Search'` fragment in sync with the message text
  in `process.js`.

## Process for the next upstream merge

1. Create a branch `merge-upstream-<tag>` off `main`.
2. `git fetch upstream --tags && git merge <tag>`.
3. For every file listed in this doc, verify the customization survived the
   auto-merge. The handy check is:
   ```sh
   grep -n 'needsAzureRefresh\|resolveHeaders\|processMCPEnv\|specLabel\|h-10 w-10\|font-bold\|modelSpecs.list\|getPageCount\|providerFileUpload\|assertProviderUploadWithinPageLimit\|RAG_FULL_CONTEXT_MAX_PAGES' <file>
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
6. `api/app/clients/prompts/createContextHandlers.js` (RAG full-context vs
   retrieval routing — section 9)
