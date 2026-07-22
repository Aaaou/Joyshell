# Icon Assets Attribution

## Scope

This note records third-party icon sources used or planned for Joyshell UI assets.

## Source

- Iconfont collection page: https://www.iconfont.cn/collections/detail?spm=a313x.collections_index.i1.d9df05512.58573a81v00OvQ&cid=54289
- Local archive used for review: `D:\Download\download (1).zip`

## Package Contents

The downloaded archive is a complete Iconfont export package and includes:

- `iconfont.css`
- `iconfont.js`
- `iconfont.json`
- `iconfont.ttf`
- `iconfont.woff`
- `iconfont.woff2`
- demo assets

The `iconfont.json` metadata shows project id `5214392` and glyph names such as `HTML`, `TXT`, `PDF`, `PNG`, `ZIP`, `MD`, and others.

## Attribution Guidance

- Keep the original source link in release notes or third-party notices when these assets are bundled.
- Do not claim ownership of the icon glyph artwork.
- Verify the collection's reuse terms on iconfont before redistributing packaged builds.
- Prefer referencing the collection URL and project id in code comments or asset manifests instead of embedding a long license essay in UI code.

## Recommended Release Note Text

> Icon assets sourced from Iconfont collection `cid=54289` / project `5214392`.

## Practical Usage

- Use these icons for the SFTP file browser and transfer queue file-type visuals.
- Keep core action icons in the app on a separate icon set when possible.
- If the asset set changes, update this note with the new collection URL, archive name, and project id.
