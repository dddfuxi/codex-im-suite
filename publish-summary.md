# Publish Summary

- Time: 2026-04-25 20:07:10
- Subject: fix session detail history and expose one-click publish
- Summary source: manual

## Preview

- Fixed group session detail loading so message streams return first, Feishu history dedupes duplicate message IDs, and media downloads no longer block the detail drawer.
- Restored interactive card visibility by replacing Feishu client fallback text with audit summaries and preventing card image keys from appearing as fake `.bin` attachments.
- Added an obvious one-click publish entry to the control panel topbar and release page, wired to the existing `release.publishBackup` command.
- Rebuilt the WebView panel, live skill, portable package, and installer payload from the suite workspace.

## Commit Body

Control panel:
- Show a topbar “一键发布” button and rename the release action from “本机备份发布” to “一键发布”.
- Surface session detail loading errors instead of silently falling back to the empty detail placeholder.
- Keep group session detail responsive by limiting fresh attachment downloads and using cached media where possible.
- Render interactive Feishu card summaries from audit records when the raw history only contains client-upgrade fallback text.

Feishu history:
- Deduplicate merged history records by `messageId` to tolerate early index files with duplicated key variants.
- Avoid extracting fake file placeholders from `interactive` card payloads.

Release:
- Build WebView assets, compile the control panel host, refresh portable/installer artifacts, and sync the live skill.
