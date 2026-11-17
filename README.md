# Discord Image Cooldown Guard v3

Limits how many images you send per time window on Discord (web), so you never
hit a channel's "can't send another image" rule. One codebase, four ways to use it.

| Format | File | Best for |
|---|---|---|
| Userscript | `discord-image-guard.user.js` | Tampermonkey / Violentmonkey / Greasemonkey (recommended) | (Under Additional Install Methods Folder)
| Browser extension | `discord-image-guard-extension.zip` | Chrome / Edge / Brave, toolbar popup settings |
| Console snippet | `discord-image-guard.console.js` | One-off use: paste into DevTools console | (Under Additional Install Methods Folder)
| Bookmarklet | `discord-image-guard.bookmarklet.txt` | One click per page load, no install | (Under Additional Install Methods Folder)

## 1. Userscript (Tampermonkey etc.)
1. Install Tampermonkey (or Violentmonkey) in your browser.
2. Create a new script, paste the whole of `discord-image-guard.user.js`, save.
3. Open or reload discord.com. Works on discord.com, canary and ptb.

## 2. Browser extension (Chrome / Edge / Brave)
1. Unzip `discord-image-guard-extension.zip`.
2. Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick the folder.
3. Reload Discord. Click the extension icon for settings.

## 3. Console snippet
Open Discord, press F12, open the Console tab, paste the contents of
`discord-image-guard.console.js`, press Enter. Lasts until the page reloads.
(Your browser may ask you to type "allow pasting" first.)

## 4. Bookmarklet
Create a new bookmark, paste the entire contents of
`discord-image-guard.bookmarklet.txt` as its URL, and click it on Discord after
each page load. Clicking it again opens the settings panel.
Some browsers or Discord's security policy may block bookmarklets; use the
userscript or extension if so.

## Using it
Open settings by clicking the badge (bottom-right), pressing **Alt+Shift+G**, or
using the Tampermonkey menu. In the extension, use the toolbar icon.
- **Max images per N minutes**: rolling window, e.g. 2 images per 10 min.
- **Safety buffer**: extra seconds so server-side timing never catches you.
- **Count**: images only, or any attachment.
- **Apply to**: all channels, or only channels you list.
- **Channel rules**: per-channel limits ("+ Add current channel" while on that channel).
- **Allow override**: press Enter twice within 4s to send anyway (off by default).
- **Reset**: clear the timer for a channel or everything (e.g. if a send failed).
- **Export / Import** (userscript, console, bookmarklet): share settings as JSON.

## Notes
- Storage: userscript uses the manager's storage; console/bookmarklet use
  localStorage; the extension uses browser sync storage. They don't share data,
  so use only one at a time.
- Discord hashes its CSS class names. Attachment selectors are editable in the
  settings (Advanced); if none match, it counts `blob:` image previews instead.
- Browser Discord only (not the desktop app). It records a send when allowed, not
  when Discord confirms it, so use Reset if a send fails.
- A message with more images than the max is blocked outright.
