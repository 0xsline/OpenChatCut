# Repository layout index

OpenChatCut keeps build-tool configuration under `config/` and load-bearing
project files at the repository root. This file is the single index for that
split — update it whenever a file moves.

## config/

| File | Consumed by | How it is passed |
|---|---|---|
| `vite.config.ts` | Vite (dev server, build, preview) | explicit `--config` flags in `package.json` scripts and in `scripts/dev-profile.mjs` |
| `vite.config.verify.ts` | `npm run verify:affected` / manual | run as `npx tsx config/vite.config.verify.ts` |
| `electron-builder.config.mjs` | electron-builder packaging | `--config config/electron-builder.config.mjs` in the `desktop:dist*` scripts |
| `.oxlintrc.json` | oxlint | `oxlint -c config/.oxlintrc.json` in the `lint` script |

Notes:

- `config/vite.config.ts` imports server modules via `../server/...` — adjust
  together if the `server/` directory ever moves.
- `desktop/update-packaging.verify.ts` guards the electron-builder config
  location and the `--config` script flags; CI runs it through `npm test`.
- `.oxlintrc.json` carries both `public/mediapipe/**` and `../public/mediapipe/**` ignore patterns: oxlint may resolve ignorePatterns against the cwd or the config directory, and the dual pattern matches either way.

## Repository root (deliberately kept here)

| Entry | Why it stays at the root |
|---|---|
| `package.json` / `package-lock.json` | npm and Node.js conventions; every script and CI step reads them |
| `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | `tsc -b` project references, and tsconfig `include`/exclude paths resolve relative to the config location; dozens of `tsx --tsconfig` invocations reference them |
| `.env.example` | dotenv convention, plus the `.gitignore` negation `!.env.example` anchors it here |
| `.nvmrc` | Node version-manager convention (root lookup) |
| `.mcp.json` | MCP clients (Claude Code etc.) discover it at the repo root; README documents this path |
| `index.html` | Vite entry convention (project root) |
| `README.md` / `README_ZH.md` / `CHANGELOG.md` / `LICENSE` | GitHub landing page, release notes, and license conventions |
| `.gitignore` | Git root-level convention |
| `assets/` | README/product static assets (the website and release tooling may reference these paths) |

## Documentation policy

The `docs/` directory is reserved by `.gitignore` for private working
documents and is never committed. Publishable documentation lives in the
README files and on the website.

## Source directories

| Directory | Purpose |
|---|---|
| `src/` | Browser/editor UI, agent, media, persistence (renderer) |
| `server/` | Dev/production server plugins, storage, external-agent bridges |
| `desktop/` | Electron main process, native workers, packaging |
| `shared/` | Contracts shared across renderer, server, and desktop |
| `remotion/` | Headless render entry for Remotion-based export |
| `scripts/` | Dev profile launcher, test runners, binary sync, i18n check |
| `skills/` | Agent skills distributed to external MCP agents |
| `public/` | Runtime user media (uploads, on-device models); never shipped in `dist/` |
| `.github/` | CI workflows and issue templates |

## Planned architecture (TS UI + plugin system, C++ backend)

The agreed direction splits the codebase into a TypeScript UI/plugin layer and
a C++ performance backend. The authoritative design document will define the
backend directory layout (e.g. a native/ tree with CMake), the FFI/WASM
contract, and the CI native-build stages. Until that document lands, this
reorganization stays design-agnostic: no source directories moved, no native
tree created. When the backend lands, keep this index in sync and add the
native toolchain steps to `.github/workflows`.