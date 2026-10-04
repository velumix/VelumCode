# Velum Code terms of use

**DRAFT FOR OWNER AND LEGAL REVIEW — NOT YET EFFECTIVE.**

Version: draft-2026-10-01. Effective date: **[EFFECTIVE_DATE]**.
Publisher: **[PUBLISHER_LEGAL_NAME]**, based in **[PUBLISHER_COUNTRY_AND_STATE]**.
Legal contact: **[LEGAL_CONTACT_EMAIL]**.

This draft proposes terms for a downloadable desktop application and its phone
companion. It must be finalized alongside the project license and the acceptance
process described in the release guide before it is presented as an agreement.

## 1. About Velum Code

Velum Code provides an interface to coding agents supplied by separately
installed command line tools, including Muse, Codex and Antigravity. It also
provides local conversations, terminals, memory, queues, plugins, bot schedules,
task boards and optional phone access. Your desktop runs the agent processes.
Closing the window normally keeps the app running in the Windows tray.

In these terms, "Publisher", "we" and "us" mean the publisher identified above;
"you" means the person using the app or the organization that person is authorized
to represent. We are independent of the providers and other services used with
the app. Their agreements apply to their services.

## 2. Eligibility and agreement

The proposed release is intended for adults who can enter a binding agreement
where they live. You must be at least 18 and satisfy that local requirement. If
you use the app for an organization, you must have authority to act for it.

Final terms must be available before you accept them. An explicit acceptance
control will identify the terms version you accept. Merely reading this draft,
using an earlier build, or receiving an update does not mean that you accepted
this draft. If you do not agree to the final terms presented to you, do not accept
them; you may stop using and uninstall the app.

## 3. Software license and third-party rights

**[PROJECT_LICENSE_DECISION_REQUIRED]** The publisher must specify the approved
application license and its scope before this section becomes effective.

For a proprietary distribution, the proposed grant is a non-exclusive license
to install and use authorized copies of the executable on devices you own or
are authorized to operate, subject to these terms. It does not grant rights to
redistribute Velum-owned source, sell copies, or use the Velum brand to imply
endorsement. For an open source distribution, the selected software license
instead controls the permissions it grants; this section must be adapted to it.

Third-party components are provided under their own licenses, listed in the
accompanying third-party notices. Their licenses control those components. No
restriction, termination or disclaimer in these terms removes rights that those
licenses or mandatory law give you. Any additional warranty, support or other
promise from the Publisher is offered by the Publisher alone, not by upstream
contributors. The app's license does not transfer ownership of your content.

## 4. Your accounts, workspaces and content

You are responsible for choosing providers, maintaining your accounts, complying
with their terms, and paying their charges. Velum does not include a provider
subscription or guarantee a particular model, rate limit, token price, response
speed or continued provider availability. Usage figures shown in the app are
informational and are not billing records.

Provide only content you are authorized to use, and authorize access only to
files and services you are permitted to access. Do not use the app to violate
law, infringe others' rights, compromise systems, or abuse other users or
services. Review licenses and confidentiality obligations for material you
provide to an agent, plugin or remote device.

You retain the rights you already have in your prompts, files and other content.
You authorize the processing necessary for features you choose, including
passing context to your selected CLI and displaying it to approved devices.
This is not a general grant for the Publisher to train models on your content.
Your provider's own terms determine its processing and any rights it grants in
generated output. Velum cannot promise that output is original, exclusive,
copyrightable or free of third-party rights.

## 5. AI output and actions

Agents can make mistakes, invent information, create insecure code and perform
unexpected actions. Check their work before relying on it, deploying it, sharing
it, or using it for a consequential decision. The app is not a professional
medical, legal, financial or other regulated advice service.

Depending on your CLI and permissions, an agent or terminal can read, change
or delete files, execute programs, access networks and use connected services.
Standard mode is not a guarantee that every action requires your approval.
YOLO deliberately enables a provider's permission bypass and can remove its
approval or sandbox protections. Keep backups and choose a workspace and
permission level appropriate for the task.

Velum's optional host tools have separate permissions from provider shell
sandboxes. Project file removal is permanent and is not a recycle-bin operation.
Browser previews can contact sites and perform page actions. Desktop screenshot
and native input permissions, when enabled, can expose visible information or
interact with Windows apps under your account. YOLO does not enable these
desktop permissions. A managed local MCP registration may be added to Muse
and Antigravity configuration, with an original-file backup. Review the
[agent tools guide](docs/agent-tools.md) and choose permissions appropriate for
the work you authorize. Disabling access does not undo actions or recall
information already received by another party.

Queued messages can run automatically when active work finishes. Enabled bot
schedules can run while Windows is awake and the app is open or in the tray.
Review pending messages, schedules and permissions before leaving work
unattended. Use Stop, pause schedules/queues, or explicitly Quit Velum Code when
you intend to stop background work. Corrections and saved lessons provide
context; they do not guarantee that an agent will follow them or avoid repeating
a mistake.

## 6. Plugins and remote access

Install plugins only from sources you trust and review their permissions. A
directory listing is not an endorsement, verification of ownership or security
audit. Plugin authors provide their own licenses and may have their own policies.
Technical restrictions reduce access but cannot promise a perfect sandbox.

Pair only devices you trust. View-only access can expose conversation content;
control access can initiate agent work and change supported app data. Protect
your desktop, phone, Tailscale account and USB debugging access. Revoke lost or
untrusted devices promptly. Revocation cannot recall information already viewed,
copied or captured on a device.

## 7. Privacy and local data

Read the accompanying privacy notice for the current data flows and controls.
Local storage is not a backup service and Velum does not encrypt its saved
conversation and memory files. Your operating system, browser, cloud backup
software and selected external services may also store data.

Uninstalling the app does not necessarily remove saved settings, transcripts,
memory, provider records, browser data or synchronized copies. You control your
local files; external services control their records. Avoid putting secrets or
confidential material into public support reports.

## 8. Fees, support and changes

Version 0.7.6 has no Velum account, in-app billing or paid feature system. Provider
and other third-party charges are separate. Any future Velum purchase requires
its own disclosed price, billing and cancellation/refund terms before purchase;
these terms do not authorize undisclosed charges.

Installed Windows copies check GitHub for signed app updates, download new
stable releases, verify their signatures, then install and reopen automatically
during startup by default. You can turn automatic updates off in **Settings → Updates**.
Updates downloaded while the app is open require **Restart to update**, which
closes terminal sessions, or install automatically on the next launch. An app
update does not establish acceptance of these draft terms.

Unless a separate agreement says otherwise, no uptime, response-time, recovery,
maintenance or compatibility commitment is offered. Features and external
integrations may change. Mandatory consumer rights and any express promises
made for a purchase remain applicable.

Material changes to this agreement must be clearly identified and presented
prospectively, with fresh acceptance where required. Posting a replacement file
does not retroactively change an agreement you accepted. The privacy notice
must be updated when actual data handling changes.

## 9. Warranty disclaimer

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, VELUM CODE IS PROVIDED
"AS IS" AND "AS AVAILABLE". THE PUBLISHER DISCLAIMS WARRANTIES AND CONDITIONS,
EXPRESS, IMPLIED OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. THE PUBLISHER DOES NOT
WARRANT ERROR-FREE OR SECURE OPERATION, ACCURATE AI OUTPUT, UNINTERRUPTED
ACCESS, OR PREVENTION OF DATA LOSS.**

**UPSTREAM CONTRIBUTORS PROVIDE THEIR COMPONENTS UNDER THE DISCLAIMERS IN
THEIR RESPECTIVE LICENSES. NO ADDITIONAL PUBLISHER PROMISE IS MADE ON THEIR
BEHALF.**

These disclaimers do not exclude warranties, consumer guarantees or other
rights that cannot lawfully be excluded, and do not override an express promise
that applicable law requires the Publisher to honor.

## 10. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE PUBLISHER WILL NOT
BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL OR CONSEQUENTIAL LOSS, INCLUDING
LOST PROFITS, LOST OPPORTUNITIES, BUSINESS INTERRUPTION OR LOSS OF DATA,
ARISING FROM USE OF OR INABILITY TO USE THE APP.**

**[LIABILITY_CAP_AND_CURRENCY_REQUIRED]** A monetary cap, if appropriate, must be
chosen and reviewed for the intended distribution and applicable law before
this draft becomes effective. No enforceable cap is asserted by this placeholder.

Nothing in this agreement excludes or limits liability that cannot lawfully be
excluded or limited, including fraud, intentional misconduct, personal injury
or other protected claims to the extent mandatory law so requires. If a
limitation is unenforceable, the applicable law controls. Your non-waivable
consumer and statutory rights are preserved.

## 11. Ending use

You may stop using and uninstall the app at any time, subject to any separate
purchase agreement and third-party obligations. If a proprietary license is
selected, the finalized license must describe when a material breach permits
termination and any required notice or opportunity to cure. These drafts do
not implement remote deactivation or removal of your local files.

Ending an app license does not cancel provider accounts, erase third-party
records, revoke an independent open source license or remove legal rights
already granted for a third-party component.

## 12. Disputes and contact

Please contact **[LEGAL_CONTACT_EMAIL]** about concerns. You retain the right to
use courts, regulators and other remedies available under applicable law.

**[GOVERNING_LAW_AND_VENUE_REQUIRED]** The Publisher must obtain jurisdiction-
appropriate wording that preserves mandatory rights and any right to bring
claims locally. This draft does not select a jurisdiction, require arbitration,
waive class actions, or shorten statutory claim periods.

If a provision is found unenforceable, it applies only to the lawful extent and
the remainder applies where legally permitted. These terms and the applicable
software license cover their respective subjects; a separate written agreement
controls any additional services it expressly covers.
