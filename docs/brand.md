# Velum Code identity

The **Chiseled Crystal `V` & Diamond Core** mark uses faceted sapphire-blue and electric-cyan planes on a pure transparent background so it renders cleanly across dark, light, and Crystal Glass surfaces without a container box.

## Assets

- `assets/velum-mark.svg`: background-free `1024 × 1024` editable vector master.
- `src/assets/velum-mark.png`: `256 px` RGBA transparent PNG UI export used in README and app chrome.
- `src/components/VelumMark.tsx` and `src/components/VelumMark.css`: live animated SVG emblem reactive to agent state (`idle`, `starting`, `thinking`, `working`, `done`, `error`).
- `src-tauri/icons/`: Windows `.ico`, tray/notification PNGs, macOS `.icns`, and mobile icon exports.
- `src-tauri/nsis/`: NSIS installer header (`header.bmp`) and wizard sidebar (`sidebar.bmp`) artwork.
- `android/app/src/main/res/drawable-nodpi/velum_mark.png`: Android icon/welcome mark.
- `public/velum-icon.png`, `public/velum-192.png`, `public/velum-512.png`: favicon and mobile web app icons.
- `docs/images/velum-hero-banner.png`: widescreen hero showcase graphic for the repository README.

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-assets.ps1` from the repository root to regenerate every rasterized PNG, ICO, PWA icon, Android drawable, and NSIS bitmap directly from `assets/velum-mark.svg`. Every shipped mark is exported from the transparent crystal `V` master; obsolete container-backed sources have been removed.

## Interaction and surface language

Conversations keep controls folded until needed, surface tool/diff/swarm activity cleanly even while collapsed, adapt token and diff colors automatically across all twelve dark and light themes, and honor `prefers-reduced-motion`.

Product names read **Velum Code**. Bundle IDs, the Windows notification identity, and the Android signing identity retain their original values so upgrades keep user data intact.
