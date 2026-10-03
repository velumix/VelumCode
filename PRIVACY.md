# Velum Code privacy notice

**DRAFT FOR OWNER AND LEGAL REVIEW — NOT YET A FINAL PUBLISHER NOTICE.**

Behavior reviewed: desktop 0.7.5 and Android companion 0.6.1, October 3, 2026.
Effective date: **[EFFECTIVE_DATE]**.
Publisher: **[PUBLISHER_LEGAL_NAME]**, **[PUBLISHER_COUNTRY_AND_STATE]**.
Privacy contact: **[PRIVACY_CONTACT_EMAIL]**.

This notice covers the Windows app, its phone web interface and the Android
companion. It describes the current implementation, not an assurance that every
service involved has the same practices. Local use does not mean that data can
never leave a device.

## At a glance

- Velum has no user account, advertising SDK, Velum analytics service or automatic
  upload of conversations to a Velum-operated server in this version.
- Your selected AI CLI can send prompts, workspace files and context to its
  provider. Its account settings and policies govern that processing.
- Conversations, drafts, queues, preferences, boards, bots and memory are saved
  on your devices. Velum does not encrypt its saved text files.
- Paired phones receive desktop conversation content. Control access can also
  initiate work and edit supported app data.
- Microsoft WebView2, Android WebView, Tailscale, GitHub, external images and
  provider software can make network requests independently of a Velum backend.

## 1. Information and where it goes

| Information | Purpose and storage | When another party receives it |
| --- | --- | --- |
| Prompts, responses, tool activity, workspace paths and provider session identifiers | Local conversation display and bounded restart recovery | Sent to the selected CLI; its provider may receive it. Approved phones can view Agent conversations. |
| Workspace files and command output | Agent work, terminals, app context and approved plugin reads | The selected CLI/tools may transmit them; a phone can view content displayed in the conversation. |
| Drafts and pending messages | Resume typing and run queued work | Saved on desktop and, for phone drafts, in that phone's browser storage; submitted content goes to the selected CLI. |
| Shared, project and bot memory; corrections saved as lessons | Local Markdown notes and selected context for future turns | Selected active excerpts go to the CLI; approved phones can view relevant memory. Pending review notes are not injected as active memory. |
| Bot names, instructions, pictures, preferences, schedules, board tasks and run history | Local team and planning features | Bot instructions and assigned task context go to the chosen CLI during work; paired devices can view supported features. Pictures use local data, not an external avatar URL. |
| Appearance and workflow preferences | Customize and restore the interface | Saved on the device. Some desktop workspace/provider choices are reflected in the remote interface. Exporting a profile creates a file you choose to share. |
| Phone names, permissions, pairing status and credential hashes | Approve and revoke device access | Saved on desktop; phones store a login cookie. Tailscale handles its own account and connection information. |
| Plugin code, permissions and private settings | Install and run optional tools | Browsing/installing/updating contacts public GitHub services. A plugin receives only the supported host data permitted for that command. |
| Sign-in authorization code | Complete an optional Antigravity CLI sign-in | Temporarily forwarded to that CLI; not saved as a chat message. The CLI handles provider credential storage. |
| Browser preview pages, semantic snapshots, screenshots and optional native app actions | An isolated preview browser or separately enabled Windows controls; temporary preview profiles can contain page data/cookies | Page hosts receive browser requests. Selected page content and screenshots go to the CLI/provider and can appear in its records. Native input can act in Windows apps under your account. |
| Host tool configuration, timing and provider token counts | Local permission settings and sanitized per-turn diagnostic metadata; managed Muse/Antigravity MCP registrations | Token counts/timing can be attached to a provider message. MCP setup is local; original provider configuration backups may contain existing credentials. |
| Diagnostics or support material you choose to copy, attach or submit | Troubleshoot a problem | Attached context goes to the selected CLI. Reports you submit go to the chosen support channel and its operator. Public issues are public. |

Velum does not require you to enter an API key into a Velum account. Provider
CLIs can maintain their own credentials, logs and session files outside Velum's
storage. A terminal can also display or process sensitive input; the absence
of a Velum account does not make that input private from the selected CLI.

## 2. AI providers and other external services

Your provider receives the data its CLI sends. That can include prompt text,
project files read by tools, command results, application context, diagnostics,
bot instructions and selected memory. Check the provider's agreement and account
controls before sending sensitive data. Velum does not determine the provider's
retention, training, deletion, international transfers or output ownership rules.

Relevant external notices include [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/),
[Google's privacy policy](https://policies.google.com/privacy),
[Tailscale's privacy policy](https://tailscale.com/privacy-policy),
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
and [Microsoft's privacy statement](https://privacy.microsoft.com/en-us/privacystatement).
Use the current notice for your Muse operator and each other tool or service
you connect. Consumer and business/API arrangements may differ.

The installed Windows app checks GitHub for signed app updates during the opening
animation by default, downloads a newer stable release, verifies its signature,
then installs and reopens automatically before recovering the workspace.
It also checks every six hours while open and downloads releases in the
background. Turn off automatic checks, downloads and startup installation in **Settings → Updates**;
manual update actions still contact GitHub. Update requests carry connection
metadata, not conversations, drafts, workspace paths or provider credentials.
Updates downloaded during an open session require **Restart to update**, or install
automatically on the next launch. Failed launch checks open the current version.

Opening the plugin directory or checking/installing an update contacts GitHub's
public repository/API services. Those services receive ordinary connection
information such as your IP address and request metadata. Opening external
links contacts the destination in your browser. Markdown images can load from
external hosts when a message is displayed, exposing connection information
to that image host even without clicking a link.

Windows uses Microsoft's WebView2 Runtime to display the app. **The software
includes Microsoft Defender SmartScreen, which can collect and send information
to Microsoft as described in Microsoft's privacy statement.** WebView2 also
has runtime diagnostics and crash reporting; Windows diagnostic settings affect
some collection, and required runtime data may still be sent. See
[Microsoft's WebView2 data and privacy guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy).
The runtime may be downloaded from Microsoft if missing during installation.
Android WebView and your operating system have their own update, diagnostic
and storage behavior. These are separate from the absence of Velum analytics.

The optional host tools bridge binds file operations to a selected project and vault search to enabled active project/shared/current-bot notes. A file removal is permanent and hash-checked; it is not a recycle-bin operation. Browser previews use a fresh temporary profile, separate from your personal browser. Velum closes it at turn end and attempts cleanup, but a crash or file lock can leave data in the system temporary directory. Optional desktop screenshots can include private information and overlapping windows. Desktop capture and native input default to off and are separate from YOLO. Disabling a capability blocks subsequent calls; it does not undo completed actions or recall provider data. See the [agent tools guide](docs/agent-tools.md).

## 3. Local storage and retention

The desktop app uses its application configuration directory for recent
conversation recovery, preferences, device grants, boards, bot profiles,
schedules and plugins. Recovery keeps up to 32 tabs, bounded recent event history
per conversation and bounded drafts; it is not a complete archival transcript
or backup. Saved content persists across Quit and restarts until replaced or
removed through the relevant controls or local file management.

The default memory vault is in **Documents / Velum Code / Memory**, including
project, shared and bot-private notes. Notes persist until you edit, archive or
delete them. Archive is not deletion. Settings and WebView/browser storage may
contain preferences and draft copies. See the [data controls guide](docs/data-controls.md)
for the specific locations and removal steps.

Files are protected by your device's ordinary file permissions and any
encryption you enable through the operating system. Velum adds no encryption
to saved transcript or memory text. Documents folders, desktop folders and
backups may be synchronized by OneDrive or other software you configured;
that service's terms and retention then apply. Keep sensitive work on devices
and storage appropriate for it.

The Publisher cannot read or remotely delete your local files through a Velum
backend in this version. If you voluntarily send a support report, the Publisher
can receive that report. **[SUPPORT_RETENTION_POLICY_REQUIRED]** Before launch,
the Publisher must set a realistic retention policy and describe any support
systems used. Do not send a full conversation, credentials or private files
unless necessary; review every attachment before sending.

## 4. Phone access, cookies and drafts

Remote access is optional. Your desktop hosts the phone interface. You must
approve a device before it can access Agent conversations. View-only devices
can read the supported desktop content; control devices can also send messages,
manage queues and change supported memory, bot and board data.

For Tailscale access, your tailnet and Tailscale Serve provide private HTTPS.
The authentication cookie uses HttpOnly, SameSite=Strict and Secure. For USB,
Android Debug Bridge forwards an HTTP service to the phone's exact loopback
address `127.0.0.1:43827`; this local USB route is not HTTPS and its cookie does
not use Secure. Protect USB debugging and authorize only trusted computers.
Desktop device credentials are saved as hashes; the phone retains its login
cookie. This is not a claim that all app data is encrypted at rest.

Phone service-worker caching covers interface assets, not API responses or
transcripts. Unsent phone drafts are deliberately saved in IndexedDB, with a
localStorage fallback, so they can survive reloads and Android process restarts.
The phone also remembers interface choices and its selected conversation.
Revocation invalidates future authenticated access; the phone clears drafts
when it observes the revoked/disconnected state. A device that stays offline
may retain local content until it reconnects or its storage is cleared. Content
already viewed, copied, photographed or captured cannot be recalled.

The Android companion remembers the approved desktop address and uses WebView
cookies and storage. Camera permission is requested for optional QR scanning.
A system picture picker lets you select a bot image. The companion does not
upload QR camera frames to a Velum service. It can check for or open the Tailscale
app. Android cloud backup and device transfer are excluded by its current backup
configuration; this does not control screenshots or independent backup tools.

## 5. Choices and deletion

- Choose your provider, workspace, permissions and content before starting work.
  Pause queues and schedules or Quit to stop further automated actions.
- Edit/delete memory or disable its use in Settings. Deletion does not remove
  excerpts already sent to a provider or present in an existing conversation.
- Close a desktop conversation to remove its saved Velum recovery file. This
  does not remove provider history, memory, copied text or backups.
- Revoke paired devices on desktop. In Android, **Forget desktop** clears the
  companion's saved address, WebView storage, cookies and cache. For the web app,
  clear that site's browser data to remove local drafts and cookies.
- Uninstall a plugin to remove its Velum-managed code and private local storage.
  Remove bots, board data or local configuration separately when appropriate.
- Uninstalling Velum may leave app configuration and your memory vault. Follow
  the [data controls guide](docs/data-controls.md) after backing up anything you
  want to retain. Provider accounts and third-party records need their own controls.

Clipboard actions and file/picture selection are user initiated. Diagnostics
are previewable before you attach or share them; sanitization of some metadata
cannot guarantee that your own text contains no secrets.

## 6. Privacy requests, children and changes

Contact **[PRIVACY_CONTACT_EMAIL]** for questions or requests about information
the Publisher actually holds, such as a report you submitted. Depending on
applicable law, you may have rights to access, correct, delete or restrict that
information and complain to a regulator. Local device files and provider
records require the respective device/service controls. The Publisher must
identify its jurisdiction, relevant lawful bases and any required regional
disclosures before this notice becomes final.

The proposed terms are for adults, and the app is not intended as a product
directed to children. An age statement by itself does not establish compliance
with children's privacy laws. The Publisher must review the actual audience
and respond appropriately if it receives a child's personal information.

Update this notice when actual processing changes and show the applicable
effective date. New analytics, hosted services, billing, advertising, support
systems or training uses require a fresh data review and any notice or consent
required by applicable law before those changes take effect.
