# chenbinPT AI Coding Agent Instructions

## Project Overview
chenbinPT is a browser extension (Manifest v3) for enhancing Private Tracker (PT) site usability. Built with Vue 3 + TypeScript + ant-design-vue (antd), it provides multi-site search, torrent management, and downloader integration.

## Architecture & Key Components

### Web Extension Structure
- **Background Service Worker**: `src/entries/background/main.ts` - handles core extension logic
- **Content Scripts**: `src/entries/content-script/` - injected into PT sites  
- **Options Page**: `src/entries/options/` - Vue 3 SPA for configuration
- **Offscreen Documents**: `src/entries/offscreen/` - for secure operations

### Module System (`src/packages/`)
- **Site**: `@ptd/site` - PT site definitions, scrapers, and metadata
- **Downloader**: `@ptd/downloader` - Integration with qBittorrent, Transmission, etc.
- **BackupServer**: `@ptd/backupServer` - WebDAV, Gist, Google Drive sync
- **MediaServer**: `@ptd/mediaServer` - Jellyfin, Plex, Emby integration
- **Social**: `@ptd/social` - Douban, IMDb, TMDB data fetching

### Storage & State Management
- **Extension Storage**: `@webext-core/storage` for cross-context data persistence
- **Pinia Stores**: Vue state management with persistence plugins
- **IndexedDB**: For large datasets (search results, download history)

## Development Patterns

### Path Aliases (tsconfig.json)
```typescript
"~/*": ["src/*"]           // Root source files
"@/*": ["src/entries/*"]   // Extension entries
"@ptd/*": ["src/packages/*"] // Modular packages
```

### Message Passing
- Use `@webext-core/messaging` for background ↔ content script communication
- Message definitions in `src/entries/messages.ts`
- Pattern: `onMessage("messageType", handler)` and `sendMessage("messageType", data)`

### Site Integration
- Site schemas in `src/packages/site/schemas/` extend `AbstractBittorrentSite`
- Site definitions in `src/packages/site/definitions/` contain metadata + schema mapping
- Selector-based scraping using Sizzle for DOM parsing

### Vue 3 Composition API
- Use `<script setup>` syntax consistently
- Prefer `ref()`/`reactive()` over Options API
- ant-design-vue 4 components (`a-*`); `npm run check:antd` 是迁移验收门禁（禁止 Vuetify 残留、原生控件等）

## Build & Development

### Key Commands
```bash
npm run dev                    # Development server with HMR
npm run build:dist            # Build Chrome extension
npm run build:dist-firefox    # Build Firefox addon
npm run check                 # TypeScript type checking (src/, via vue-tsc)
npm run check:node            # TypeScript type checking for vite.config.ts / vite/**/*.ts (tsconfig.node.json)
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
- Chrome: Uses service worker background script
- Firefox: Uses legacy background scripts (`ff_main.ts`)
- Conditional manifest via `{{chrome}}` / `{{firefox}}` tokens

### Vite Configuration
- `vite-plugin-web-extension` generates manifest.json dynamically
- Multi-target builds with `TARGET=firefox` environment variable
- Node.js polyfills for crypto, buffer operations

## Testing & Quality

### Code Standards
- Prettier formatting (120 char width, semicolons, trailing commas)
- TypeScript strict mode enabled
- Husky pre-commit hooks for linting

### Site Compatibility
- Support for NexusPHP, Unit3D, Gazelle tracker engines
- Graceful degradation for unsupported sites
- User agent and cookie handling for authentication

## Common Patterns

### Adding New Site Support
1. Create schema in `src/packages/site/schemas/`
2. Add definition in `src/packages/site/definitions/`
3. Implement required methods: `getUserInfo()`, `searchTorrents()`, `getTorrentInfo()`

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
- **Build Tools**: Vite, TypeScript
- **Utilities**: axios, date-fns, es-toolkit, jszip, crypto-js

This is a sophisticated multi-platform extension requiring careful attention to web extension APIs, cross-site scripting, and torrent ecosystem integrations.
