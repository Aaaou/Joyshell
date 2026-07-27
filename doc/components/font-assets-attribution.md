# Font Assets Attribution

## Source

- Font family page: https://www.iconfont.cn/fonts/detail?spm=a313x.fonts_index.i1.d9df05512.443b3a81QAnOD4&cnid=pOvFIr086ADR
- Bundled source/license files: `apps/desktop/src/assets/fonts/alimama-fangyuan/`

## Source Files

- `AlimamaFangYuanTiVF-Thin.ttf`
- `AlimamaFangYuanTiVF-Thin.woff`
- `AlimamaFangYuanTiVF-Thin.woff2`
- `LICENSE.txt`
- `INSTRUCTION.txt`

## Runtime Files

Chromium/WebView2 rejected the original variable font files with `OTS parsing error`, so Joyshell uses a static embedded runtime instance generated from the source font:

- `AlimamaFangYuanTi-Regular.ttf`
- `AlimamaFangYuanTi-Regular.woff`
- `AlimamaFangYuanTi-Regular.woff2`

Generation parameters:

- Source: `AlimamaFangYuanTiVF-Thin.ttf`
- Tool: `fonttools varLib.instancer`
- Axes pinned for the UI instance: `wght=450`, `BEVL=50`

The generated runtime files are used only as embedded application assets and must not be redistributed as a standalone font package or renamed as a new font.

## License Summary

The archive states that Alibaba Mamai FangYuanTi is free for personal, enterprise, commercial, non-commercial, and embedded use, subject to its terms.

Keep the copyright notice attribution in release notes or third-party notices.
Do not imply endorsement by Alibaba or TaoBao.
Do not redistribute modified font software as a new font.

## Usage in Joyshell

The font is used as the primary UI text font for the desktop app shell.
Monospace terminal rendering remains separate and is not replaced by this font.

Before public release, re-check the upstream license terms for generated/static embedded instances and keep this attribution in third-party notices.
The repository should publish a root `THIRD_PARTY_NOTICES` file before distribution; this component note is an engineering record, not legal advice.
