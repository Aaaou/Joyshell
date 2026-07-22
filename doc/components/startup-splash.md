# Startup Splash

## Source

The startup animation is based on the user-provided portable Joyshell splash package:

```text
C:/Users/EDY/.codex/visualizations/2026/05/25/019e5ccb-72fe-7c73-b0d9-0121c374a877/joyshell-splash-portable
```

Imported asset:

- `apps/desktop/src/assets/splash/center-joy-cropped.png`

Derived asset:

- `apps/desktop/src-tauri/icons/icon.ico`

## Implementation

The original package used standalone HTML/CSS/JS. Joyshell integrates it as a React component in:

- `apps/desktop/src/ui/App.tsx`
- `apps/desktop/src/styles.css`

The splash is a first-render overlay, not a separate web product. It runs inside the packaged Tauri desktop window.

## Animation Behavior

- Default duration: `4.2s`.
- The orbit/text/center-image animation follows the provided portable package.
- On completion, the whole splash scales down and moves toward the top-left brand logo position.
- The top-left brand logo uses the same center image.
- The Windows application icon is regenerated from the same image so the in-app logo and taskbar/window icon match.
- `prefers-reduced-motion` shortens animation timing.

## Current Limits

- The shrink target is tuned for the current left sidebar brand position.
- If the sidebar spacing or brand size changes significantly, update `joyshell-splash-to-brand` in `styles.css`.
- Future versions can expose the center image as a user appearance setting.
