# ClaudeChat

WhatsApp-style messenger where every chat is a Claude Code agent.

> Unofficial community project. Not affiliated with or endorsed by Anthropic or WhatsApp. It drives your own locally installed [Claude Code](https://claude.com/claude-code) CLI, so agent usage counts against your own Claude plan.

**Features:** one chat per agent, each with its own folder, model and effort · **Claude Code and Google Antigravity (Gemini 3.8 Flash and more) agents side by side** · group chats where agents talk to each other · Codex-style approvals for risky actions · live session and weekly usage meter · broadcast · attachments, voice input and replies · Windows `.exe` with its own app window.

Licensed under the [MIT License](LICENSE).

## Run

Double-click `Start ClaudeChat.bat`, or:

```
node server.js
```

Then open http://localhost:4317. You need Node 18+ and Claude Code (`claude`) installed and logged in. There's nothing to `npm install`.

## Windows app (.exe)

```
node build/build-exe.js
```

This builds `ClaudeChat.exe` (Windows x64, ~90 MB) under `dist/exe-builder/`. Each build goes in a new folder, so earlier builds are never overwritten. The exe has the Node runtime and the web UI built in, so it doesn't need Node installed. It does need Claude Code (`claude`) installed and logged in.

Double-click it and ClaudeChat opens in **its own app window**: no tabs or address bar, with its own ClaudeChat icon in the taskbar. It uses Edge's or Chrome's "app mode", one of which every Windows PC has. There's no console window, and **closing the window quits ClaudeChat**. Starting it again while it's open just opens another window. Chats are saved in a `data` folder next to the exe, and `data/claudechat.log` has the server log. `Start ClaudeChat.bat` opens the same app window when you run from source.

The build uses Node's single-executable-app feature. Instead of `postject`, it embeds the app with a tiny injector (`build/inject.cs`) compiled by Windows' built-in C# compiler, so nothing gets downloaded. The exe is unsigned, so the first launch may show Windows SmartScreen: choose **More info → Run anyway**.

## Google Antigravity (Gemini) agents

If the [Antigravity](https://antigravity.google) CLI (`agy`) is installed, pick **Provider → Antigravity (Gemini)** when creating an agent. ClaudeChat loads Antigravity's model list at startup, for example **Gemini 3.8 Flash** (Low/Medium/High effort), Claude Sonnet 4.6 and Opus 4.6, and GPT-OSS 120B. Gemini and Claude agents can sit in the same group chat.

- **Approvals:** Antigravity's headless mode can't stop to ask, so it blocks commands. ClaudeChat runs its danger check on each blocked command. Safe ones it runs itself, risky ones get the usual Allow/Deny card, and the result goes back to the agent. Only the exact command that was checked ever runs. File edits inside the agent's folders happen directly.
- **Usage:** Antigravity agents show tokens used in the usage card. They count against your Google plan, not your Claude limits.
- **Notes:** Antigravity has no system-prompt flag, so an agent's instructions go along with its first message. Antigravity can't start in a working folder with a very long path, so pick a short folder.

## How it works

- Each chat runs `claude -p` in its own **working folder**, with that chat's **model**, **effort** and **permission mode**, and resumes its own session, so every agent keeps its memory between messages.
- The pill in the chat header (e.g. `Opus 5.5  High  ◔`) switches model and effort. The ring fills as effort goes up. The change applies from the next message.
- Tool calls (Bash, Edit, Read…) show up as collapsible cards. Click one to see its input and output.
- The 📣 button broadcasts one message to several agents at once.
- Unread badges, a "typing…" status, blue ticks when an agent has answered, a sound when an agent you aren't looking at finishes, and desktop notifications when the tab is in the background.
- The ⋮ menu has per-agent settings: name, avatar, folder, permissions, custom instructions, pin, new session and delete.

### New in v2

- **Full PC access** (per agent, on by default): the agent gets every drive (`C:\`, `D:\`…) via `--add-dir`, not just its folder. Turn it off in the agent's info panel.
- **Folder browser**: "Browse…" next to the working folder lets you pick any folder on any drive, with Home, Desktop, Documents, Downloads and drive shortcuts and a "New folder" button.
- **Usage card**: the meter at the bottom of the sidebar shows your **Session limit** (5-hour) and **Weekly** usage with reset times. The numbers are the ones Claude Code reports after each reply. ⟳ refreshes with a tiny Haiku request, and 📊 shows estimated spend per agent.
- **Group chats** 👥: put several agents in one chat. They answer in turn and see each other's messages, and `@Name` (or `@all`) picks who answers.
- **Message queue**: you can keep typing while an agent works. Messages queue (🕓) and are sent in order.
- **Attachments**: 📎, paste or drag & drop images and files. The agent opens them with its Read tool.
- **Voice input** 🎤 (Chrome/Edge), **reply/quote** (↩ on hover), copy message, copy buttons on code blocks, mute, and **export chat** to Markdown.
- **Safety**: the server only accepts requests from its own page on `localhost`, so other websites can't drive your agents.

Chats are saved in `data/chats.json`, attachments in `data/uploads/`. Set `PORT` or `CLAUDE_BIN` env vars to override the defaults.

**Permissions: Codex-style approvals.** The default mode is **Ask when risky**. Safe work runs on its own: reading, searching, and edits and commands inside the agent's working folder. When an agent tries something risky, it pauses and a ⚠️ card appears in the chat with **Allow**, **Always allow** and **Deny** (you can add a note telling it what to do instead). The chat list shows "Waiting for your approval", and you get a sound and desktop notification even for muted chats. The checks live in `danger.js`, and an action is risky if it:

- deletes files (`rm`, `del`, `Remove-Item`…) or clears data
- edits a file outside the working folder, or changes files with a command that uses an outside path
- touches secrets: `.ssh`, keys, `.env`, credentials, browser profiles, system folders
- changes the registry, services, firewall, execution policy, users or scheduled tasks, or uses admin rights
- runs `git push`, `reset --hard`, `clean -f` and similar, or publishes packages
- pipes a downloaded script into a shell (`iwr … | iex`), or kills processes
- formats disks, shuts down the PC, or installs/uninstalls software

**Always allow** remembers the command's first two words (e.g. `git push`), or the folder for file edits. The agent's info panel lists these rules, where you can remove them. Other modes: **Ask every time**, **Claude decides** (Claude Code's auto mode, never asks), **Accept edits**, **Plan**, and **Bypass** (no checks at all).

`data/chats.backup.json` holds a copy of your chats from the last time the server started.
