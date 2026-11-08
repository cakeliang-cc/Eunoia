# ADR 031 — Multimodal messages and private media

- Status: Accepted
- Date: 2026-11-08
- Supersedes: nothing. Extends ADR 026 (attachments were workspace files, never
  model input) and ADR 016 (SQLite).
- Related: ADR 005 (model runtime), ADR 026 (uploads), ADR 029 (finish reasons),
  ADR 030 (per-request context budget).

## Context

ADR 026 gave the product file attachments that live in the task workspace and are
named to the model as paths. It deliberately said images are *not* visual input,
because they were not: the message had one string, the model port had one string,
and nothing could carry pixels.

That boundary is now being removed for still images. The requirement is not
"the browser can select a file"; it is a chain in which all of the following are
true at once:

1. a private, immutable asset exists and is owned by a conversation;
2. the message stores ordered text/image blocks, with a derived text projection;
3. history, regeneration, continuation and crash recovery resolve the same bytes;
4. a route that cannot accept images is refused before a user message or a
   running turn exists;
5. the token and HTTP-body budgets use the actual encoded request variant;
6. the frontend distinguishes draft, uploading, ready and failed states and
   retries without executing a request twice.

Audio, video, animation, SVG, PDF and image *generation* remain out of scope.

## Decision

### 1. Content is ordered, versioned blocks

A user message carries `UserContentV1 = { version: 1, parts }` where a part is
text or an image reference:

```ts
type InputPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly assetId: string };
```

The order is the meaning and is preserved through storage, replay and encoding.
The `content` string remains as a derived projection for the old client, search
and export; the store derives it from the text parts in the same transaction, so
a caller cannot write two disagreeing representations. A null `content_parts` on
an old row is read deterministically as one text block.

Roles keep their constraints: only a user message may contain images. System
prompts, reasoning and assistant text remain strings.

### 2. Assets are private, immutable and separate from the workspace

`media_assets` records the owner, conversation, actual decoded MIME, oriented
dimensions, raw byte count, SHA-256, storage keys, status and derived variants.
`message_assets` is the ordered reference join; the row is the reference count.

Bytes are written by a storage port:

- `original` — exactly the uploaded bytes; never rewritten;
- `normalized` — EXIF orientation applied, metadata (including GPS) stripped;
- `request` — the normalized image with its long edge bounded by the product
  policy, never upscaled. The **actual encoded** dimensions and SHA-256 are
  stored and are what the token policy counts.

Files live under `MEDIA_ROOT` (default `data/media`, beside the SQLite file),
with process-private permissions. A write goes to a temporary directory and is
renamed into place; a decode or database failure removes it. The workspace is
not the source of truth: a same-named workspace file changing cannot change a
stored message.

The accepted formats are JPEG, PNG and WebP, verified by decoding. SVG, GIF,
animated WebP/PNG, multi-page images and PDFs are refused with a specific 415.

### 3. Capability is three-valued, per route

A `ModelProfile` declares `input.text`, `input.image`, `output.text`, `tools`,
an image policy id and a `policyRevision`. `unknown` is a real value and is
refused for a new image request: absence of a declaration is not permission.
`MODEL_CATALOG` currently declares `deepseek-flash` as image-capable and
`deepseek-v4-pro` as text-only because only the former has been verified against
the current vision guide. A conversation can pin either route; the UI reads
`/api/media/capabilities`, never a model name.

The available capability is the intersection of the model declaration, the
adapter's encoder and the registered image policy. A route that declares vision
but names no registered policy is `MODEL_CAPABILITY_UNKNOWN`, not zero tokens.

### 4. Request planning is pure and comes before the model

`src/agent/request-plan.ts` takes the route, the policy, current content, the
replay window and asset metadata. It returns either a typed error or an immutable
plan containing each image's request-variant dimensions, byte count and digests,
its estimated and upper-bound tokens, the text estimate, the effective input
limit and the estimated request-body size.

The plan is produced twice:

- **preflight** before admission, using metadata only, so a 422 leaves no
  message and no running turn;
- **commit** after the replay is final, then the exact request variants are
  loaded and leased. The adapter encodes those bytes; it cannot re-scale or
  replace an image at send time.

Every loop step passes the same images, and the context budget counts every
occurrence. Storage deduplicates bytes; the model context does not. A later
tool-loop request therefore costs the images again, which is what the provider
actually charges.

The DeepSeek policy reproduces the documented `v41` calculator (14px patches,
3:1 per-axis downsample, 544×544 floor, 1024-token cap, row separators and two
framing tokens) and is pinned to `deepseek-flash-v41`. The vectors in the budget
document are assertions in `tests/provider/image-tokens.test.ts`. A second
offline route (`fake-tile-v1`) uses a different formula, different limits and a
different wire field to prove the planner has no vendor branch.

### 5. Budgets stay separate

Three numbers are never mixed:

- raw storage bytes, used for upload and per-message limits;
- encoded request-body bytes (`4 * ceil(n / 3)` for Base64, plus prefix, JSON,
  UTF-8 text and tool schemas), checked before encoding and against the final
  bound;
- model input tokens, from the route's policy on the actual request variant.

`effectiveInputLimit = min(product input budget, contextWindow - output reserve
- safety buffer)`. The point estimate is checked first; a point estimate that
fits but a documented upper bound that does not is
`CONTEXT_BUDGET_UNCERTAIN`, not a false claim of certain overflow. A body overrun
is `REQUEST_BODY_TOO_LARGE`, never a context error.

Actual provider usage is recorded on the turn as reported. The local image
estimate is never added to it, and image-token detail is marked unknown because
the provider does not split it.

### 6. Errors and HTTP status

New errors use `{ error: { code, message, retryable, details } }`; old
string-shaped errors are kept for existing routes and the client accepts both.

| Status | Meaning |
| --- | --- |
| 400 | malformed content structure, both `message` and `content`, bad ids |
| 404 | asset missing, not this user's, or in another conversation (one answer) |
| 409 | admission conflict, request-id conflict, deleting a bound draft |
| 413 | byte/dimension/pixel limit, encoded body too large |
| 415 | unsupported, fake or corrupt media |
| 422 | model capability, tools, or budget preflight |

`MODEL_INPUT_UNSUPPORTED` carries `scope: current | history`; an image already
replaced by a summary is not in the replay window and does not block a text
route. `MODEL_CAPABILITY_UNKNOWN` is distinct from both unsupported and budget.
Provider errors (401/429/5xx/rejection) keep their own message, end the accepted
turn as failed, keep the input and the asset, and never rewrite the capability
or retry automatically.

### 7. API and client

- `POST /api/media/images?conversationId=&name=` — raw bytes, 201 asset view.
- `GET /api/media/images/:id` — owner-and-conversation scoped preview, correct
  MIME, `nosniff`, private `no-store`, no path.
- `DELETE /api/media/images/:id` — releases a draft only; a bound asset is 409.
- `GET /api/media/capabilities` — product limits and every route's declaration.
- `POST /api/chat` — `content` for new clients, `message` still accepted, both
  together is 400. An image-only message is valid and is stored with an empty
  text projection; no prompt is invented.
- `GET /messages` — text projection plus authorized image metadata and preview
  URL per block.
- `POST /api/chat/regenerate` — preflights the stored content *before* rewinding
  the old reply.

The client keeps a per-draft state machine (`local → uploading → ready | failed`),
uploads sequentially, binds an upload to the conversation that started it,
aborts or discards a late response on a switch, releases object URLs, and clears
drafts only after the server accepts the turn. Paste, drop and the picker share
one queue; non-image files keep the workspace path. Text-only sends keep the
legacy `message` field; an image send uses `content`. Retries reuse the request
id and the exact accepted body.

The composer has a model selector populated from the capability endpoint. An
unsupported model blocks the send but does not delete the draft or switch
automatically.

### 8. Storage, migration and deletion

Schema version 9 adds `messages.content_parts`, `media_assets`,
`message_assets` and `turn_requests.usage`. The migration is additive,
idempotent and checked with `PRAGMA table_info` before each `ALTER TABLE`; an old
database is upgraded on open and re-opening it twice changes nothing.

`appendMessage` writes the projection, the blocks and the asset references in one
transaction. Deleting messages releases unreferenced assets; deleting a
conversation or user removes rows via the cascade and the route removes the
blobs using the rows captured before the cascade. Cleanup deletes only
`released`/unbound assets past the grace window and skips a live lease; it never
scans filenames.

`npm run backup` now copies the database, every recorded original/variant and a
manifest with SHA-256 digests. It puts a lease on assets while copying, verifies
every file, writes restore instructions and exits non-zero if any file is
missing. `npm run backup:verify` re-checks a backup without writing to it.

## Consequences

- The default conversation model is text-only. Sending an image requires
  selecting the Flash route; the UI says so and keeps the draft.
- Preview is the bounded request variant, not the original. The original remains
  private and is what a future higher-detail route can use.
- A provider that returns no usage leaves the turn's usage null; it is not
  treated as zero.
- There is no OCR fallback, no automatic cross-provider send and no rewriting of
  history to make it compatible. A route switch is an explicit user action.
- Android/iOS, audio, video, image generation and a benchmark remain future work.
  S01–S03 are wiring smoke tests, not a visual capability benchmark.
- Rollback needs a build that understands schema 9 and a backup of both the
  database and media. An older binary refuses to open the database, which is the
  intended failure rather than a silent misinterpretation.

## Sources

- DeepSeek Vision guide, retrieved 2026-11-08:
  <https://api-docs.deepseek.com/guides/vision/>
- DeepSeek Responses API and token usage, retrieved 2026-11-08.
- `deepseek-harness` `packages/llm/llm-deepseek/src/image-tokens.ts`, `v41`
  calculator, retrieved 2026-11-08 from `master` at implementation time. The
  arithmetic and constants are reproduced in
  `src/provider/deepseek/image-tokens.ts`; the local policy revision records the
  date because a moving branch has no stable commit in this checkout.
- ADR 026 for the attachment path that remains for non-visual files.
