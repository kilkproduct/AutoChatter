# AutoChatter

A JavaScript/TypeScript-only Valenced plugin prototype for a configurable, global-interval plain-text scheduler.

> **Important capability limitation:** scheduled message delivery is deliberately disabled. The current Valenced source, public plugin API documentation, and `@valenced/types` declarations do not confirm a supported plugin message-send API or its success/failure contract. AutoChatter will retain an overdue send and show **Supported Valenced send API unavailable**; it will not call Discord's private `MessageActionCreators.sendMessage`, issue raw HTTP, or send anything. The channel/settings/scheduling code is implemented independently and tested with an injected fake sender.

## Included

- Native Valenced settings UI using `@valenced/components`, `@valenced/discord/design`, React Native controls, and the current host theme.
- A configurable plain-text message with a preset/custom editor. The default preset is exactly `Meow\n\nmrrrp meow meow`.
- Interval validation in the editor, scheduler, and persisted-settings repair path. Default: **7,200 seconds**; minimum: **600 seconds**. There is no product-imposed upper cap; values must fit JavaScript's safe-integer range.
- Explicit channel selection. New installs start with **no selected channels**. At a send decision, the scheduler rechecks the currently viewed channel, selection, channel existence, and current send permission. It never falls back to a different or previously viewed channel.
- One global cooldown anchored to the last successful send, one pending send after a missed deadline, no catch-up bursts, and a continuous **10-minute foreground grace period** after an overdue interval is found while inactive or across a runtime restart.
- Persisted recovery state, serialized writes, timer/subscription cleanup, and an in-flight attempt guard. Rejected sends are not retried automatically; ambiguous delivery is held to avoid duplicates.
- A fail-closed messaging adapter. The absence of an approved Valenced send API is visible in the settings screen and in the README rather than disguised as working delivery.

## Install

The packaged ZIP is:

- **`artifacts/AutoChatter-0.1.0.zip`** (deliverable; ZIP contains `manifest.json`, `index.js`, and `assets/icon.svg`)
- The template-compatible archive path is `build/dist/dev.kilkproduct.auto-chatter@0.1.0.zip`.

On platforms where Valenced exposes file installation, copy the ZIP to the device and use **Settings → Plugins → Advanced → Install from file**. The current Valenced source hides this action on iOS. After installation, enable AutoChatter in the Plugins list and open its settings.

The ZIP is structurally installable, but **installation does not enable message delivery**: the plugin remains fail-closed until Valenced confirms the supported send API described below. Device installation and device/runtime testing were not performed in this environment.

## Configure

1. **Enable AutoChatter** if you want its interval to run. The first interval begins when enabled for the first time.
2. Choose **Meow preset** or **Custom message** and edit the text. Empty/whitespace-only messages are rejected. Discord's current composer maximum is discovered from its read-only `getMaxMessageLength` helper when available; the fallback is the standard 2,000-character limit. The helper is version-sensitive and is used only for input validation, never to send.
3. Set an integer **Interval in seconds**. Default is 7200; values below 600, fractions, non-decimal notation, non-finite values, and numbers outside JavaScript's exact integer range are rejected. Invalid persisted intervals are repaired to 7200.
4. Select each channel explicitly in **Channel selection**. Nothing is selected automatically. Only channels exposed by Discord's channel list and currently view/send-permitted are listed; the scheduler still uses only the current channel at send time.
5. Keep Valenced foregrounded for ten continuous minutes if an interval expires while the app is inactive or AutoChatter starts with an overdue send. Backgrounding resets that grace period. No message is sent while inactive.

A settings change never sends a message. If a pending send becomes ready because you changed channel selection or other settings, the screen offers an explicit **Send pending message now** control—but it will remain unavailable until a supported sender is added.

## Build, test, and package

Requirements: Node.js **22.18 or newer**, npm, and Python 3. The Valenced CLI dependency is pinned to the official template's compatible CLI source; `@valenced/types` is pinned to the researched Valenced types revision.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

`npm run build` uses the official `valenced-plugin build` CLI and writes `plugins/auto-chatter/build/js/index.js`. The official template's ZIP task is Gradle-based and requires Java; Java is unavailable in this build environment. `npm run package` therefore uses a small Python standard-library packager to create the same JS-only ZIP layout (`manifest.json` + `dist.script` at the ZIP root + `assets/`) and copies the requested deliverables into `artifacts/` so they are preserved outside ignored build directories.

The local typecheck uses a narrow declaration fallback in `types/valenced-api-fallback.d.ts`: the pinned upstream Git package's `files` list omits its `.d.ts` declarations, even though the official CLI still uses its included module maps. The fallback is type-only, documents its upstream commit, and does not add runtime behavior.

## What is needed to enable sending

Please do not replace the adapter with an undocumented private action. Before a real sender can be implemented safely, Valenced must confirm all of the following:

1. The **public/approved plugin API or documented module** for sending plain text to an explicit channel ID.
2. Its exact payload/signature and any required composer normalization fields.
3. Its response contract—how to distinguish an accepted message (ideally a message ID or documented confirmed result) from rejection and ambiguous delivery, including HTTP 429/rate-limit behavior.
4. That scheduled plugin-originated sends are permitted and that the API applies the current user's ordinary channel access and send permissions.

The team confirmation that the AutoChatter concept is allowed subject to channel-selection restrictions does not itself identify this interface. Until the sender and response contract are confirmed, this package is safe/configurable but **not an automatic message sender**.

## Tests and validation

- `npm run typecheck`: TypeScript no-emit typecheck.
- `npm test`: deterministic fake-clock tests for interval validation/repair, global timing, current-channel selection, permissions/deletion, foreground grace/reset, long offline periods, no catch-up, stop/restart, failure/retry policy, validation, absent sender, and persistence failure.
- `npm run build`: official Valenced CLI bundle.
- `npm run package`: ZIP integrity/layout is checked separately after building.
- No device installation, live Discord send, or end-to-end permission test was performed.

See [`docs/features.md`](docs/features.md) for implementation details, compatibility assumptions, and edge-case behavior.
