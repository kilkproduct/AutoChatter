# AutoChatter feature and implementation notes

## Scope and delivery status

AutoChatter implements the configuration surface, resilient state model, global scheduler, foreground grace logic, and current-channel eligibility gate. The runtime messaging adapter intentionally returns `unavailable` on every call. This is deliberate: Valenced's public source/docs/types do not confirm a plugin message-send API or response contract, and the observed private Discord action is not used.

The scheduler is unit-tested with an injected sender to verify what it would do **if** Valenced provides a supported adapter. Those tests are not evidence that Discord delivery works. In the real plugin build, `isAvailable()` is always false, so there are no live send calls.

## Configuration and validation

`js/types.ts` defines the persisted settings and scheduler state. `js/validation.ts` is the shared validation boundary used for UI feedback, scheduler checks, and storage-load repair.

- Default message: `Meow\n\nmrrrp meow meow`.
- Default interval: 7200 whole seconds; minimum: 600.
- No product-imposed upper interval. Values must remain finite, integral, and exactly representable by JavaScript's `number` type.
- Invalid, missing, non-finite, fractional, negative, or too-small stored intervals are repaired to 7200 before the scheduler computes a deadline.
- Selected channel IDs are deduplicated; malformed IDs are removed; no IDs are added by default.
- An interrupted `in-flight` attempt is recovered as `uncertain`, not retried automatically.
- State writes are serialized through the official per-plugin JSON storage API. A storage failure before a send attempt prevents that attempt.

## Timing and state transitions

`js/scheduler.ts` is independent of Valenced globals. It receives a clock, foreground status, current-channel reader, eligibility checker, message-limit reader, sender adapter, persistence callback, and logger through `SchedulerPorts`.

1. Before the first successful send, the interval is anchored to the time AutoChatter is enabled. After a confirmed success, the sole global deadline is `lastSuccessfulSendAt + intervalSeconds`.
2. No channel is tied to the interval. At the deadline, the scheduler inspects only the channel currently viewed.
3. A successful result clears the pending item and starts the next interval from the confirmed success timestamp. Rejections do not advance the cooldown.
4. An expired interval creates at most one pending send. Long offline periods never create multiple queued or catch-up messages.
5. If the deadline passes while inactive, or an overdue item is recovered from an earlier runtime session, the scheduler waits for ten uninterrupted foreground minutes. Backgrounding clears the grace start; returning starts a fresh ten-minute period.
6. No attempt begins while inactive, and current foreground/channel/selection/permission/message conditions are rechecked after persisting the attempt record and immediately before invoking the adapter.
7. A rejected attempt is held for user retry. Ambiguous delivery is marked `uncertain` and requires a second explicit confirmation because retrying could duplicate a message. There are no automatic retries.
8. Stop clears timers, persists the runtime-session transition, and resets an in-progress foreground grace period so a later runtime cannot accidentally inherit continuous activity.

The interval timer is chunked at one minute to avoid platform timeout overflow for large intervals. It does not poll or send while the app is backgrounded.

## Channel eligibility

`js/channels.ts` reads Valenced's Flux store proxy and observed Discord channel-list/store methods to enumerate channels, determine the selected channel, and recheck permission. It fails closed if a store, channel, or permission method is unavailable. Guild channels use the Discord permission store's `VIEW_CHANNEL`, `SEND_MESSAGES`, and thread-send permission bits; deleted/inaccessible channels and locked/archived threads are rejected. DMs are surfaced only from Discord's sorted private-channel list, rechecked against that list at send time, and must pass the current `SEND_MESSAGES` permission check. If Discord does not expose that check for a DM, AutoChatter fails closed for it. Every destination must still be the currently viewed, explicitly selected channel.

These Discord store method shapes are version-sensitive client internals rather than a stable Valenced channel abstraction. They are not used to bypass permissions. The public Valenced Flux helper is used for store access; community references informed the observed `SelectedChannelStore`, `ChannelStore`, `ChannelListStore`, and permission-store method shapes. Device validation is still needed across supported Discord/Valenced builds.

The message maximum is read from Discord's `getMaxMessageLength` composer helper when discovered via Valenced's module finder; otherwise it falls back to 2000. This is read-only validation, not a sending API. The helper is version-sensitive; validation fails conservatively if the helper returns an invalid value.

## Native settings UI

`js/settings.tsx` uses the host's native `Page`, `Design.Stack`, `Card`, `TableRowGroup`, `TableRow`, `TableSwitchRow`, `TableRadioGroup`, `TextInput`, `Text`, and `Button` components. It has no WebView or external web surface. Channel rows are built only from the current accessible/sendable list; stale selected IDs are shown as removable unavailable entries and are never used as a destination.

The screen always includes a messaging-capability warning. A pending message remains visible in the scheduler status, but delivery stays disabled until the adapter has an approved public API.

## API and packaging details

- Manifest: `plugins/auto-chatter/manifest.json`, format 1, plugin ID `dev.kilkproduct.auto-chatter`, version `0.1.0`.
- Required Valenced dependencies: `valenced.api >=1 <2` and the reserved `discord` compatibility declaration.
- Entry point: `plugins/auto-chatter/js/index.ts`; distribution script: `index.js`.
- Build: pinned official `@valenced/plugin-cli` and `valenced-plugin build`.
- The template's `packageAllPlugins` Gradle task is the official ZIP packager, but it could not run here because Java is absent. `scripts/package.py` mirrors the official ZIP contents and writes both `build/dist/dev.kilkproduct.auto-chatter@0.1.0.zip` and the preserved deliverable `artifacts/AutoChatter-0.1.0.zip`.
- `types/valenced-api-fallback.d.ts` contains only a small type-only subset of the pinned official Valenced 1.3.0 declarations. The Git package's published `files` list omitted `.d.ts` files; the fallback lets TypeScript check the exact APIs used without changing the bundle.

## Known limitations / next steps

- No supported sender is currently configured. The exact missing interface and confirmation items are listed in the root README.
- Store APIs and the composer length helper are version-sensitive; their behavior needs real device testing.
- There was no device install, runtime execution, or live message test in this environment.
- Once Valenced confirms the public sender and its contract, implement only that adapter in `js/messaging.ts`, add response-contract tests, then rerun typecheck, scheduler tests, official CLI build, ZIP inspection, and device tests.
