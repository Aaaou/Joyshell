# Icon Assets Attribution

## Scope

This note records third-party icon sources used or planned for Joyshell UI assets.

## Sources

| Purpose | Iconfont project | Repository path | Source status |
| --- | --- | --- | --- |
| File types, folder, shell, other | `5214392` | `apps/desktop/src/assets/iconfont/` | Collection page: https://www.iconfont.cn/collections/detail?cid=54289 |
| Operating systems | `5215323` | `apps/desktop/src/assets/os-iconfont/` | Imported from user-provided `操作系统图标.zip`; upstream collection URL/license still needs recording |
| Common UI actions | `5214464` | `apps/desktop/src/assets/ui-iconfont/` | Imported from user-provided `常见ui图标.zip`; upstream collection URL/license still needs recording |
| Joyshell application mark | Project-owned raster export | `apps/desktop/src/assets/brand/joyshell-terminal-mark-*.png` | User-provided native 16/20/24/32/48/64/128/256 px PNG family from `D:\Download\logo\16原生` |

The UI action package is stored for the next design pass but is not loaded at runtime yet. It contains Symbol IDs that overlap with the file package, so individual icons must be namespaced or selectively extracted before activation.

## Package Contents

The downloaded archive is a complete Iconfont export package and includes:

- `iconfont.css`
- `iconfont.js`
- `iconfont.json`
- `iconfont.ttf`
- `iconfont.woff`
- `iconfont.woff2`
- demo assets

The file package metadata shows project id `5214392`. The latest archive adds `wenjianjia`, `SHELL`, and `a-huaban1` for directories, shell scripts, and unmatched files.

The operating-system package currently contains Windows, macOS, Ubuntu, Alpine, CentOS Stream, Fedora, Red Hat, and FreeBSD. Debian and unknown systems deliberately use a generic OS fallback instead of displaying an incorrect distribution logo.

The Joyshell application mark is stored under descriptive ASCII filenames. Windows `icon.ico` embeds all eight supplied native PNGs instead of scaling one source at runtime. Tauri's `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, and `icon.png` select the matching native source. The macOS ICNS embeds the supplied 16/32/48/128/256 px PNG payloads.

## Attribution Guidance

- Keep the original source link in release notes or third-party notices when these assets are bundled.
- Do not claim ownership of the icon glyph artwork.
- Verify the collection's reuse terms on iconfont before redistributing packaged builds.
- Prefer referencing the collection URL and project id in code comments or asset manifests instead of embedding a long license essay in UI code.

## Recommended Release Note Text

> File icons sourced from Iconfont collection `cid=54289` / project `5214392`. Operating-system and UI icon projects `5215323` and `5214464` require their upstream source/license URLs before public redistribution.

## Practical Usage

- Use these icons for the SFTP file browser and transfer queue file-type visuals.
- Keep core action icons in the app on a separate icon set when possible.
- If the asset set changes, update this note with the new collection URL, archive name, and project id.
- Before a public release, capture the collection license/authorization text in a repository-level `THIRD_PARTY_NOTICES` file; a source URL alone is not a substitute for redistribution permission.
