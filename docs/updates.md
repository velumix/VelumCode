# App updates

[Documentation](README.md) · [GitHub releases](https://github.com/velumix/VelumCode/releases)

Starting with 0.6.9, the installed Windows app checks GitHub at the beginning
of its opening animation. **Automatic updates** is on by default. If a newer
stable release is available, the animation shows download progress, then
**Installing update…**. Velum verifies the installer's signature, installs
silently and reopens automatically before recovering your workspace. Saved
conversations, drafts and preferences are preserved. Scheduled and remote agent
work waits until this startup decision finishes.

The launch check has an eight-second deadline. If GitHub is offline, the feed
is invalid, or download/signature verification fails, the installed version
opens normally and Settings records the error. **Open current version** cancels
the launch check or download; it is unavailable once installation starts.
If an installer fails to replace the app, the next launch opens the current
version instead of repeatedly restarting. Retry that release manually in
Settings; a newer release can still install automatically.

While Velum stays open, including in the tray, it checks every six hours and
downloads new stable releases in the background. It does not interrupt active
work to install them.

When the download is ready, **Update ready** appears in the footer. Open it,
then choose **Restart to update**, or quit and let the next launch update
automatically. Finish or stop running conversations and
pause pending queues first. Velum saves the desktop, drafts, preferences and
conversation recovery before launching the installer. Terminal sessions close.
The installer keeps app data and reopens the updated app.

In **Settings → Updates**, you can check manually, read release notes, or turn
off automatic checks, downloads and startup installation. Turning it off does not cancel a download
already in progress. With automatic updates off, **Check for updates** offers
a separate **Download update** action. Downloaded bytes are held for the current
app session; quitting without installing means a later session downloads again.
Debug builds, raw executables, isolated QA instances and the phone
companion do not perform desktop updates.

## First installation

Versions through 0.6.5 do not contain an updater. Install the latest signed
Windows bundle once to add it. Versions 0.6.6 and 0.6.7 can download the new
version in Settings and require **Restart to update** once to install it.
Automatic installation during launch is available in the stable 0.6.9 release. The update
feed only includes published stable GitHub releases; drafts and prereleases
are excluded. Until the first release is published, Settings reports that
the feed is unavailable.

## Publishing a new version

GitHub builds the installer once per release; users download the compiled
installer and do not need Rust, Node or a local checkout. Every push to
`main` ships a release automatically — there is no manual bump, tag or
publish ritual. The **Auto-release on main** workflow bumps the patch version
(`scripts/auto-bump.mjs` replicates a manual bump file for file), regenerates
bundled dependency notices, verifies legal and release consistency, commits
`[skip ci]`, pushes the `vMAJOR.MINOR.PATCH` tag and dispatches the
**Windows release** workflow, which builds and signs the NSIS installer,
writes `latest.json` and checksums, and publishes the GitHub release. GitHub's
`releases/latest/download/latest.json` becomes the app's update feed.
Published release assets are immutable in this workflow; make fixes in a new
version — i.e. a new push to `main` — instead of replacing a published
installer.

Local version bookkeeping still matters because the automation derives the
next version from the tree: keep `package.json`, both npm lockfile version
fields, the Cargo package version and `src-tauri/tauri.conf.json` consistent
(the release manifest check enforces this). Review the current behavior
described in the privacy notice and terms, and keep `reviewedAppVersion` in
`legal/publisher.json` current. Release notes under `docs/releases/VERSION.md`
are generated from the commits since the previous tag; edit the generated file
before pushing when a release deserves hand-written notes.

A release can still be rebuilt for an existing version tag by dispatching
**Windows release** manually with that tag. Configure the two GitHub Actions
secrets in `velumix/VelumCode` using
`scripts/configure-github-updates.ps1`: `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The helper reads local files, checks
the public key against the app configuration and sends secrets over stdin.

The app's launch check, download and installation are automatic after publication. Updater signing
is separate from Windows Authenticode code signing.

## Local signing

The publisher's signing key is stored outside the repository at
`%USERPROFILE%\.tauri\velum-code\updater.key`, with its password in
`updater-password.txt` beside it. The directory permits only the current user,
SYSTEM and Administrators. Keep a secure backup of both: future updates need
the same signing identity. Only the public key belongs in `tauri.conf.json`.

Run `scripts/build-release.ps1` to build a signed local installer and prepare
the same release assets under ignored `artifacts/release/vVERSION`. The script restores
its signing environment variables after building. Ordinary CI previews use
`src-tauri/tauri.preview.conf.json` to build without publisher secrets.
