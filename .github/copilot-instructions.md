# chenbinPT AI Coding Agent Instructions

## Project Overview

chenbinPT is a browser extension (Manifest v3) for enhancing Private Tracker (PT) site usability. Built with Vue 3 + TypeScript + ant-design-vue (antd), it provides multi-site search, torrent management, and downloader integration.

## Architecture & Key Components

### Web Extension Structure

Built with [WXT](https://wxt.dev). `src/entrypoints/` holds thin WXT entrypoints; the real code stays in `src/entries/`:

- **Background**: `src/entrypoints/background.ts` → `src/entries/background/main.ts` (Chrome service worker) or `ff_main.ts` (Firefox background script, also registers the offscreen handlers)
- **Content script bootstrap**: `src/entrypoints/content.ts` → `src/entries/content-script/index.ts` — runs on every page, must stay tiny; detects PT/social sites
- **Content script UI**: `src/entrypoints/cs-app.content.ts` (`registration: "runtime"`) → `src/entries/content-script/app/` — injected by the background via `scripting.executeScript` (`injectContentScriptApp` message) only on matched sites; styles are inlined with `?inline`
- **Options Page**: `src/entrypoints/options/index.html` → `src/entries/options/` - Vue 3 SPA for configuration
- **Offscreen Document** (Chrome only): `src/entrypoints/offscreen/index.html` → `src/entries/offscreen/` - DOMParser / Blob work

### Module System (`src/packages/`)

- **Site**: `@ptd/site` - site definitions, engine schemas, metadata and scraping
- **Downloader**: `@ptd/downloader` - qBittorrent, Transmission, Deluge, Aria2, Flood, ruTorrent, uTorrent, Synology Download Station
- **BackupServer**: `@ptd/backupServer` - WebDAV, S3, Backblaze B2, Dropbox, Google Drive, Gist, CookieCloud, OWSS
- **MediaServer**: `@ptd/mediaServer` - Jellyfin, Plex, Emby, fnOS
- **Social**: `@ptd/social` - Douban, IMDb, TMDb, AniDB, Bangumi, TVmaze lookups

⚠️ Do not import the `@ptd/site` barrel into the service worker or the content-script bootstrap: it pulls the whole definitions graph. Use deep imports (`@ptd/site/utils/html.ts`, `@ptd/site/types/torrent.ts`, …) there.

### Storage & State Management

- **Extension Storage**: `@webext-core/storage`, wrapped by `src/entries/storage.ts`. Keys: `config`, `metadata`, `userInfo`, `searchResultSnapshot`, `keepUploadTask`, plus the small `siteIndex` (`siteHostMap` / `siteNameMap`) that per-page code reads instead of `metadata`.
- **Pinia Stores**: persisted through the in-repo `src/extends/pinia/webExtPersistence.ts` plugin (`persistWebExt`); `pinia-plugin-state-persistence` is no longer used.
- **IndexedDB**: `idb`, database `ptd` (v3), created **only** in the offscreen document (`offscreen/adapter/indexdb.ts`): `social_information`, `download_history`, `favicon` (siteId → icon path). Other contexts must go through messages.
- ⚠️ The `metadata` / `userInfo` stores are large. In per-page code paths read narrow values with `getExtStoragePath` (or `siteIndex`) instead of `getExtStorage("metadata")`, which structured-clones the whole store.

## Development Patterns

### Path Aliases (tsconfig.json)

```typescript
"~/*": ["src/*"]           // Root source files
"@/*": ["src/entries/*"]   // Extension entries
"@ptd/*": ["src/packages/*"] // Modular packages
```

### Message Passing

- Use `@webext-core/messaging` for background ↔ content script communication
- Declare every message in the `ProtocolMap` in `src/entries/messages.ts`, and register exactly one `onMessage(...)` handler for it — a declared message without a handler fails silently at runtime (`tests/entries/messagesOffscreenReady.test.ts` enforces the 1:1 mapping). Handlers live in `background/utils/*` or `offscreen/utils/*`.
- Pattern: `onMessage("messageType", handler)` and `sendMessage("messageType", data)`

### Site Integration

- Engine schemas in `src/packages/site/schemas/`: `AbstractBittorrentSite`, `AbstractPrivateSite`, plus `NexusPHP`, `Unit3D`, `Gazelle`, `GazelleJSONAPI`, `AvistazNetwork`, `Luminance`, `Rartracker`, `TCG`
- Site definitions in `src/packages/site/definitions/<id>.ts` export `siteMetadata`; **the file name must equal `siteMetadata.id`** (the loader uses the file name as `siteId`)
- Selector-based scraping: `IElementQuery` (`selector` / `attr` / `filters` / `elementProcess`), parsed by the in-repo selector layer `src/packages/site/utils/selector.ts` (Sizzle-compatible, Sizzle itself is no longer a dependency)
- `filters: [{ name, args }]` names must exist in `definedFilters` (`site/utils/filter.ts`, declared with `satisfies` so bad names fail vue-tsc in typed positions); `tests/packages/site/definitions/definitionStaticValidation.test.ts` catches the rest
- Adult sites must keep `urls` / `legacyUrls` in **rot13** (restored at load time) and must not repeat their domain in plaintext elsewhere
- **Site icons**: `public/icons/site/<id>.png|.ico|.svg`. Never rename an icon file — the resolved path is cached per siteId in IndexedDB (`favicon` store)

### Vue 3 Composition API

- Use `<script setup>` syntax consistently
- Prefer `ref()`/`reactive()` over Options API
- ant-design-vue 4 components (`a-*`); `npm run check:antd` 是迁移验收门禁（禁止 Vuetify 残留、原生控件等）

## Build & Development

### Key Commands

```bash
npm run dev                    # wxt dev (Chrome) → dist-chrome-dev; load it unpacked manually
npm run dev:firefox            # wxt dev for Firefox → dist-firefox-dev
npm run build:dist            # wxt build → dist-chrome
npm run build:dist-firefox    # wxt build -b firefox → dist-firefox
npm run check                 # TypeScript type checking (src/, via vue-tsc)
npm run check:node            # TypeScript type checking for wxt.config.ts / vite/**/*.ts (tsconfig.node.json)
npm run check:bundle          # dist-chrome bundle completeness + size budget (needs a build first)
npm run check:dist            # check:bundle for both dist-chrome and dist-firefox
npm run verify                # Release gate: check + check:node + lint + check:antd + vitest + test:legacy
npm run pack:crx              # Sign dist-chrome into build/extension.crx (self-verifying)
npm run pack:crx:build        # verify, build Chrome extension, sign it, then run check:bundle
```

Packing notes: `scripts/pack-crx.mjs` implements CRX3 itself (no Chrome binary, no extra deps beyond
`jszip`) and re-parses the written file to verify structure, embedded public key, `crx_id` and the
RSA-SHA256 signature before reporting success — a failing check exits non-zero. It reads the private key
from `--key`, `CRX_PRIVATE_KEY_FILE`/`CRX_PRIVATE_KEY`, or `build/chrome-extension-signing-key.pem`
(PKCS#8; `openssl genrsa -out build/chrome-extension-signing-key.pem 2048`). That key determines the
extension ID and must be backed up by the maintainer (it is git-ignored, never commit it).

Releases are cut locally (the repo has no CI workflows): bump the three-part `package.json` version,
run `npm run verify` (includes `check:node`; INFRA-1), build both targets, run `npm run check:dist`
(产物完整性 + 体积预算门禁，两个 target 各跑一次；INFRA-1), zip `dist-chrome`/`dist-firefox` into `build/`, run `npm run pack:crx`, then
`gh release create v<version> build/extension-chrome.zip build/extension-firefox.zip build/extension.crx`.
The manifest `version` is exactly the `package.json` version — never derive it from git state, because
`git rev-list --all --count` depends on local refs and can produce a lower version than what is already
published (Chrome refuses downgrades, the stores refuse lower versions).

### Browser Targets

- Chrome: Uses service worker background script (IIFE) + offscreen document
- Firefox: Uses background scripts (`ff_main.ts`), MV3, no offscreen document. The background is emitted as ESM (`defineBackground({ type: { firefox: "module" } })`) so it shares chunks with the options page instead of inlining the whole offscreen dependency graph into an IIFE
- Per-target manifest fields live in `vite/manifest.ts` (`buildUserManifest({ target })`)

### Build Configuration (`wxt.config.ts`)

- WXT generates manifest entry fields from `src/entrypoints/`; everything else comes from `vite/manifest.ts`
- Browser target via `wxt build -b firefox`; output goes to `dist-<browser>`
- Project aliases (`~`, `@`, `@ptd`) are re-applied after WXT's own `@`/`~` aliases (`projectAliasPlugin`)
- `web_accessible_resources` (`vite/warResources.json`) only exposes `icons/*` and `lib/*` with dynamic URLs; `check:bundle` / `pack:crx` fail if any `.js`/`.html` becomes web-accessible
- No Node.js polyfill plugin: `path` / `node:path` is aliased to the minimal `src/extends/shims/path.ts` (parse-torrent only uses `join` + `sep`), and `global` is defined as `globalThis`. Do not reintroduce multi-module polyfills; add a minimal shim instead
- Version/commit metadata comes from `vite/gitInfo.ts`, which shells out to `git` and **degrades instead of failing** when git or `.git` is missing (falls back to `GITHUB_SHA` / `GITHUB_REF_NAME`, then `unknown`)

## Testing & Quality

### Code Standards

- Prettier formatting (120 char width, semicolons, trailing commas, LF)
- TypeScript strict mode enabled
- Husky + lint-staged run Prettier / ESLint on staged files; commitlint checks commit messages
- Unit tests: Vitest (`npm test`, `tests/**/*.test.ts`, happy-dom); `npm run test:legacy` runs the older tsx suite

### Site Compatibility

- Support for NexusPHP, Unit3D, Gazelle tracker engines
- Graceful degradation for unsupported sites
- User agent and cookie handling for authentication

## Common Patterns

### Adding New Site Support

1. Pick the engine — override hooks on an existing schema, or add a new schema in `src/packages/site/schemas/`
2. Add `src/packages/site/definitions/<id>.ts` with `siteMetadata` (`id` = file name, `urls`, `version`, `category`, `search`, `userInfo`, `levelRequirements`)
3. Override only what the engine's selectors cannot express. Overridable hooks: `getSearchResult()`, `transformSearchPage()`, `transformListPage()`, `transformDetailPage()`, `getTorrentDownloadLink()`, `getTorrentDownloadRequestConfig()`, `getFieldData()`, `findElementsBySelectors()`, `parseWholeTorrentFromRow()`, `fixParsedTorrent()` (`AbstractBittorrentSite`), `getUserInfoResult()` (`AbstractPrivateSite`)
4. Verify with `npm run check` and `npx vitest run tests/packages/site`

### File Downloads

- Options-page exports use a blob URL + browser download (see `src/entries/options/utils/`); `file-saver` is not a dependency — do not reintroduce it

### Cross-Browser Compatibility

- Use `chrome.*` APIs with feature detection
- Separate entry points for service worker vs background scripts
- Conditional permissions in manifest

### Error Handling

- Graceful fallbacks for network failures
- User-friendly error messages with i18n support
- Background job scheduling with `@webext-core/job-scheduler`

## Key Dependencies

- **Vue Ecosystem**: Vue 3, ant-design-vue 4, Vue Router, Pinia, Vue I18n
- **Extension Framework**: `@webext-core/*` for cross-browser compatibility
- **Build Tools**: WXT (Vite), TypeScript
- **Data**: `idb`, `fflate` (backup zip reading; writing uses the in-repo `backupServer/zipStream.ts`), `webdav`, `parse-torrent`
- **Utilities**: axios, date-fns, es-toolkit, nanoid, p-queue, @noble/hashes + @noble/ciphers (backup / CookieCloud crypto)

This is a sophisticated multi-platform extension requiring careful attention to web extension APIs, cross-site scripting, and torrent ecosystem integrations.
