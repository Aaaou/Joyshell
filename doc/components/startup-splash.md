# Startup Splash

## Source

The startup animation is based on the user-provided portable Joyshell splash package:

```text
C:/Users/EDY/.codex/visualizations/2026/05/25/019e5ccb-72fe-7c73-b0d9-0121c374a877/joyshell-splash-portable
```

Imported asset:

- `apps/desktop/src/assets/splash/center-joy-cropped.png`

Application icon source assets:

- `apps/desktop/src/assets/brand/joyshell-terminal-mark-16.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-20.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-24.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-32.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-48.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-64.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-128.png`
- `apps/desktop/src/assets/brand/joyshell-terminal-mark-256.png`

Generated bundle asset:

- `apps/desktop/src-tauri/icons/icon.ico` (all native raster sizes embedded)

## Implementation

The original package used standalone HTML/CSS/JS. Joyshell integrates it as a React component in:

- `apps/desktop/src/features/splash/JoyshellSplash.tsx`
- `apps/desktop/src/features/splash/use-splash-lifecycle.ts`
- `apps/desktop/src/styles/overlays.css`

The splash is a first-render overlay, not a separate web product. It runs inside the packaged Tauri desktop window.

## Animation Behavior

- Animation begins closing at `4.2s` and is removed at `4.7s`.
- The orbit/text/center-image animation follows the provided portable package.
- On completion, the whole splash scales down and moves toward the top-left brand logo position.
- The taskbar/window icon uses the separate Joyshell terminal mark; the configurable center image is limited to the splash.
- A 16 px native small-icon family is used for Windows sizes through 64 px; native 128/256 px exports cover larger system surfaces.
- `prefers-reduced-motion` shortens animation timing.

## Current Limits

- The shrink target is tuned for the current left sidebar brand position.
- If the sidebar spacing or brand size changes significantly, update `joyshell-splash-to-brand` in `apps/desktop/src/styles/overlays.css`.
- The center image is now configurable from Appearance settings. The image cropper supports drag positioning and wheel zoom before persisting the result in layout settings.
