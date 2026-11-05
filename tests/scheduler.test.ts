import assert from 'node:assert/strict'
import test from 'node:test'
import {
	AutoChatterScheduler,
	FOREGROUND_GRACE_MS,
} from '../plugins/auto-chatter/js/scheduler'
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
} from '../plugins/auto-chatter/js/validation'
import type {
	AutoChatterSettings,
	ChannelEligibility,
	CurrentChannel,
	SchedulerClock,
	SendOutcome,
} from '../plugins/auto-chatter/js/types'

const CHANNEL_A = '100000000000000001'
const CHANNEL_B = '100000000000000002'
const SESSION = 'test-runtime-session'
const FAKE_NOW = 1_800_000_000_000
const DUE_AT_START = FAKE_NOW - 600_000

interface FakeTimer {
	id: number
	dueAt: number
	callback: () => void
}

class FakeClock implements SchedulerClock {
	private current = FAKE_NOW
	private nextId = 0
	private timers = new Map<number, FakeTimer>()

	now = (): number => this.current

	setTimeout = (
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout> => {
		const id = ++this.nextId
		this.timers.set(id, {
			id,
			dueAt: this.current + Math.max(0, delayMs),
			callback,
		})
		return id as unknown as ReturnType<typeof setTimeout>
	}

	clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
		this.timers.delete(handle as unknown as number)
	}

	async advance(milliseconds: number): Promise<void> {
		const target = this.current + milliseconds
		let processed = 0
		while (true) {
			const next = [...this.timers.values()]
				.filter(timer => timer.dueAt <= target)
				.sort(
					(left, right) =>
						left.dueAt - right.dueAt || left.id - right.id,
				)[0]
			if (!next) break
			if (++processed > 2_000) {
				throw new Error(
					'Fake clock timer loop exceeded its safety limit.',
				)
			}
			this.current = next.dueAt
			this.timers.delete(next.id)
			next.callback()
			await flushMicrotasks()
		}
		this.current = target
		await flushMicrotasks()
	}

	get timerCount(): number {
		return this.timers.size
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 24; index++) await Promise.resolve()
}

interface FakeChannel {
	accessible: boolean
	canSend: boolean
}

interface Harness {
	clock: FakeClock
	scheduler: AutoChatterScheduler
	settings: AutoChatterSettings
	persisted: AutoChatterSettings
	channels: Map<string, FakeChannel>
	calls: Array<{ channelId: string; message: string }>
	outcomes: SendOutcome[]
	logs: string[]
	currentChannel: CurrentChannel | null
	foreground: boolean
	sendApiAvailable: boolean
	messageLimit: number
	failPersistence: boolean
	deferredSend?: {
		promise: Promise<SendOutcome>
		resolve(outcome: SendOutcome): void
	}
}

function makeSettings(
	now: number,
	options: Partial<AutoChatterSettings> = {},
): AutoChatterSettings {
	return normalizeSettings(
		{
			...DEFAULT_SETTINGS,
			enabled: true,
			intervalSeconds: 600,
			selectedChannels: [CHANNEL_A],
			scheduleStartedAt: now,
			lastSuccessfulSendAt: 0,
			runtimeSessionId: SESSION,
			...options,
		},
		now,
	)
}

function harnessFor(
	options: {
		settings?: Partial<AutoChatterSettings>
		currentChannelId?: string | null
		foreground?: boolean
		messageLimit?: number
		sendApiAvailable?: boolean
	} = {},
): Harness {
	const clock = new FakeClock()
	const settings = makeSettings(clock.now(), options.settings)
	const channels = new Map<string, FakeChannel>([
		[CHANNEL_A, { accessible: true, canSend: true }],
		[CHANNEL_B, { accessible: true, canSend: true }],
	])
	const harness: Harness = {
		clock,
		scheduler: undefined as unknown as AutoChatterScheduler,
		settings,
		persisted: settings,
		channels,
		calls: [],
		outcomes: [],
		logs: [],
		currentChannel:
			options.currentChannelId === null
				? null
				: {
						id: options.currentChannelId ?? CHANNEL_A,
						label:
							options.currentChannelId === CHANNEL_B
								? '#other'
								: '#general',
					},
		foreground: options.foreground ?? true,
		sendApiAvailable: options.sendApiAvailable ?? true,
		messageLimit: options.messageLimit ?? 2_000,
		failPersistence: false,
	}

	const scheduler = new AutoChatterScheduler(settings, {
		clock,
		isForeground: () => harness.foreground,
		getCurrentChannel: () => harness.currentChannel,
		inspectChannel: (channelId, selectedChannels): ChannelEligibility => {
			if (!selectedChannels.includes(channelId)) {
				return { allowed: false, reason: 'not-selected' }
			}
			const channel = harness.channels.get(channelId)
			if (!channel?.accessible) {
				return { allowed: false, reason: 'inaccessible' }
			}
			if (!channel.canSend) {
				return { allowed: false, reason: 'no-send-permission' }
			}
			return { allowed: true, reason: 'eligible' }
		},
		getMessageLimit: () => harness.messageLimit,
		isSendApiAvailable: () => harness.sendApiAvailable,
		sendMessage: (channelId, message) => {
			harness.calls.push({ channelId, message })
			if (harness.deferredSend) return harness.deferredSend.promise
			return Promise.resolve(
				harness.outcomes.shift() ?? {
					kind: 'confirmed',
					messageId: `msg-${harness.calls.length}`,
				},
			)
		},
		persist: async snapshot => {
			if (harness.failPersistence) {
				throw new Error('simulated storage failure')
			}
			harness.persisted = {
				...snapshot,
				selectedChannels: [...snapshot.selectedChannels],
				sendAttempt: snapshot.sendAttempt
					? { ...snapshot.sendAttempt }
					: null,
			}
		},
		newAttemptId: () =>
			`attempt-${harness.calls.length + 1}-${clock.now()}`,
		log: (_level, message) => harness.logs.push(message),
	})
	harness.scheduler = scheduler
	return harness
}

async function start(harness: Harness, sessionId = SESSION): Promise<void> {
	harness.scheduler.start(sessionId, harness.foreground)
	await flushMicrotasks()
}

test('one global interval sends at deadline and resets only after confirmed success', async () => {
	const harness = harnessFor()
	await start(harness)
	assert.equal(harness.scheduler.getSnapshot().status, 'waiting-interval')
	assert.equal(harness.calls.length, 0)

	await harness.clock.advance(600_000 - 1)
	assert.equal(harness.calls.length, 0)
	await harness.clock.advance(1)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.calls[0]?.channelId, CHANNEL_A)
	assert.equal(harness.calls[0]?.message, DEFAULT_SETTINGS.message)
	assert.equal(harness.persisted.lastSuccessfulSendAt, harness.clock.now())
	assert.equal(
		harness.scheduler.getSnapshot().nextSendAt,
		harness.clock.now() + 600_000,
	)
	harness.scheduler.stop()
})

test('the destination is the currently viewed selected channel, not a previous one', async () => {
	const harness = harnessFor({
		settings: {
			scheduleStartedAt: DUE_AT_START,
			selectedChannels: [CHANNEL_A, CHANNEL_B],
		},
	})
	await start(harness)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.calls[0]?.channelId, CHANNEL_A)

	harness.currentChannel = { id: CHANNEL_B, label: '#other' }
	harness.scheduler.onChannelContextChanged()
	await flushMicrotasks()
	assert.equal(harness.calls.length, 1)

	await harness.clock.advance(600_000)
	assert.equal(harness.calls.length, 2)
	assert.equal(harness.calls[1]?.channelId, CHANNEL_B)
	harness.scheduler.stop()
})

test('an unselected current channel holds one pending send; settings edits alone do not send', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
		currentChannelId: CHANNEL_B,
	})
	await start(harness)
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'waiting-channel')

	const selected = normalizeSettings(
		{ ...harness.settings, selectedChannels: [CHANNEL_A, CHANNEL_B] },
		harness.clock.now(),
	)
	harness.scheduler.updateSettings(selected)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'ready')

	assert.equal(harness.scheduler.retryPendingSend(), true)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.calls[0]?.channelId, CHANNEL_B)
	harness.scheduler.stop()
})

test('deleted channels and lost send permission keep the pending send until eligible', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
	})
	harness.channels.get(CHANNEL_A)!.accessible = false
	await start(harness)
	assert.equal(harness.scheduler.getSnapshot().status, 'waiting-channel')
	assert.equal(harness.calls.length, 0)

	harness.channels.get(CHANNEL_A)!.accessible = true
	harness.channels.get(CHANNEL_A)!.canSend = false
	harness.scheduler.onChannelContextChanged()
	await flushMicrotasks()
	assert.equal(
		harness.scheduler.getSnapshot().currentChannelEligibility.reason,
		'no-send-permission',
	)
	assert.equal(harness.calls.length, 0)

	harness.channels.get(CHANNEL_A)!.canSend = true
	harness.scheduler.onChannelContextChanged()
	await flushMicrotasks()
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.calls[0]?.channelId, CHANNEL_A)
	harness.scheduler.stop()
})

test('a send due during inactivity waits for ten continuous foreground minutes and resets on backgrounding', async () => {
	const harness = harnessFor()
	await start(harness)
	await harness.clock.advance(180_000)

	harness.foreground = false
	harness.scheduler.onAppStateChange(false)
	await harness.clock.advance(420_000)
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.persisted.pendingSend, false)

	harness.foreground = true
	harness.scheduler.onAppStateChange(true)
	await flushMicrotasks()
	assert.equal(harness.scheduler.getSnapshot().status, 'grace-period')
	await harness.clock.advance(FOREGROUND_GRACE_MS - 1)
	assert.equal(harness.calls.length, 0)

	harness.foreground = false
	harness.scheduler.onAppStateChange(false)
	await harness.clock.advance(50_000)
	assert.equal(harness.calls.length, 0)
	harness.foreground = true
	harness.scheduler.onAppStateChange(true)
	await flushMicrotasks()
	await harness.clock.advance(FOREGROUND_GRACE_MS - 1)
	assert.equal(harness.calls.length, 0)
	await harness.clock.advance(1)
	assert.equal(harness.calls.length, 1)
	harness.scheduler.stop()
})

test('a long offline period produces one pending send, never a catch-up burst', async () => {
	const clock = new FakeClock()
	const now = clock.now()
	const oldLastSuccess = now - 60 * 600_000
	const settings = makeSettings(now, {
		lastSuccessfulSendAt: oldLastSuccess,
		scheduleStartedAt: 0,
		runtimeSessionId: 'previous-process',
	})
	const harness = harnessFor({ settings })
	await start(harness, 'new-process')
	assert.equal(harness.persisted.pendingSend, true)
	assert.equal(harness.scheduler.getSnapshot().status, 'grace-period')
	assert.equal(harness.calls.length, 0)

	await harness.clock.advance(FOREGROUND_GRACE_MS)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.persisted.pendingSend, false)
	assert.equal(harness.persisted.lastSuccessfulSendAt, harness.clock.now())
	assert.equal(
		harness.scheduler.getSnapshot().nextSendAt,
		harness.clock.now() + 600_000,
	)
	harness.scheduler.stop()
})

test('parallel channel events cannot duplicate an in-flight attempt', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
	})
	let resolveSend: ((outcome: SendOutcome) => void) | undefined
	harness.deferredSend = {
		promise: new Promise<SendOutcome>(resolve => {
			resolveSend = resolve
		}),
		resolve: outcome => resolveSend?.(outcome),
	}
	await start(harness)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.scheduler.getSnapshot().status, 'sending')

	harness.scheduler.onChannelContextChanged()
	harness.scheduler.onChannelContextChanged()
	assert.equal(harness.scheduler.retryPendingSend(), false)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 1)

	harness.deferredSend.resolve({
		kind: 'confirmed',
		messageId: 'confirmed-1',
	})
	await flushMicrotasks()
	assert.equal(harness.persisted.pendingSend, false)
	assert.equal(harness.persisted.lastSuccessfulSendAt, harness.clock.now())
	harness.scheduler.stop()
})

test('stop cancels timers; restart recovers one overdue send with grace', async () => {
	const harness = harnessFor()
	await start(harness)
	await harness.clock.advance(180_000)
	harness.scheduler.stop()
	await flushMicrotasks()
	assert.equal(harness.persisted.runtimeSessionId, null)
	assert.equal(harness.clock.timerCount, 0)

	await harness.clock.advance(600_000)
	assert.equal(harness.calls.length, 0)

	await start(harness, 'restarted-process')
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'grace-period')
	await harness.clock.advance(FOREGROUND_GRACE_MS)
	assert.equal(harness.calls.length, 1)
	harness.scheduler.stop()
})

test('disabling pauses a due send, and re-enabling alone does not invoke the sender', async () => {
	const harness = harnessFor()
	await start(harness)
	await harness.clock.advance(120_000)

	const disabled = normalizeSettings(
		{ ...harness.settings, enabled: false },
		harness.clock.now(),
	)
	harness.scheduler.updateSettings(disabled)
	await harness.clock.advance(600_000)
	assert.equal(harness.calls.length, 0)

	const reenabled = normalizeSettings(
		{ ...disabled, enabled: true },
		harness.clock.now(),
	)
	harness.scheduler.updateSettings(reenabled)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'ready')

	assert.equal(harness.scheduler.retryPendingSend(), true)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 1)
	harness.scheduler.stop()
})

test('rejected sends are not retried automatically; user retry can recover', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
	})
	harness.outcomes.push({
		kind: 'rejected',
		status: 429,
		reason: 'Discord rate limited this request.',
	})
	await start(harness)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.persisted.sendAttempt?.state, 'failed')
	assert.equal(harness.persisted.pendingSend, true)

	await harness.clock.advance(5 * 600_000)
	assert.equal(harness.calls.length, 1)
	assert.equal(harness.scheduler.getSnapshot().status, 'send-failed')

	assert.equal(harness.scheduler.retryPendingSend(), true)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 2)
	assert.equal(harness.persisted.sendAttempt, null)
	assert.equal(harness.persisted.pendingSend, false)
	harness.scheduler.stop()
})

test('uncertain delivery is held against duplicates until explicit confirmation to retry', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
	})
	harness.outcomes.push({
		kind: 'uncertain',
		reason: 'Connection closed before response.',
	})
	await start(harness)
	assert.equal(harness.persisted.sendAttempt?.state, 'uncertain')
	assert.equal(harness.scheduler.retryPendingSend(), false)
	await harness.clock.advance(10 * 600_000)
	assert.equal(harness.calls.length, 1)

	assert.equal(harness.scheduler.retryPendingSend(true), true)
	await flushMicrotasks()
	assert.equal(harness.calls.length, 2)
	assert.equal(harness.persisted.pendingSend, false)
	harness.scheduler.stop()
})

test('message validation runs in the scheduler before any send attempt', async () => {
	const harness = harnessFor({
		settings: {
			message: 'x'.repeat(2_001),
			scheduleStartedAt: DUE_AT_START,
		},
		messageLimit: 2_000,
	})
	await start(harness)
	assert.equal(harness.scheduler.getSnapshot().status, 'invalid-message')
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.persisted.sendAttempt, null)
	harness.scheduler.stop()
})

test('a missing sender retains the pending message and never calls the send port', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
		sendApiAvailable: false,
	})
	await start(harness)
	assert.equal(harness.scheduler.getSnapshot().status, 'send-unavailable')
	assert.equal(harness.persisted.pendingSend, true)
	assert.equal(harness.calls.length, 0)
	harness.scheduler.stop()
})

test('invalid intervals are repaired by the scheduler before deadline calculation', async () => {
	const harness = harnessFor({
		settings: {
			intervalSeconds: 599,
			scheduleStartedAt: FAKE_NOW - 600_000,
		},
	})
	await start(harness)
	assert.equal(
		harness.scheduler.getSnapshot().nextSendAt,
		FAKE_NOW - 600_000 + 7_200_000,
	)
	assert.equal(harness.calls.length, 0)
	harness.scheduler.stop()
})

test('storage failure before send prevents the sender from being invoked', async () => {
	const harness = harnessFor({
		settings: { scheduleStartedAt: DUE_AT_START },
	})
	harness.failPersistence = true
	await start(harness)
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'send-failed')
	assert.match(
		harness.scheduler.getSnapshot().lastError ?? '',
		/no message was sent/i,
	)
	harness.scheduler.stop()
})

test('foreground state changes discovered during evaluation restart grace safely', async () => {
	const harness = harnessFor({
		settings: {
			scheduleStartedAt: DUE_AT_START,
			runtimeSessionId: 'previous-runtime',
		},
	})
	await start(harness, 'new-runtime')
	assert.equal(harness.scheduler.getSnapshot().status, 'grace-period')
	assert.equal(harness.calls.length, 0)

	// Simulate a background transition without delivering the AppState event. The next
	// scheduled evaluation observes it and resets the grace timestamp.
	harness.foreground = false
	await harness.clock.advance(60_000)
	assert.equal(harness.calls.length, 0)
	assert.equal(harness.scheduler.getSnapshot().status, 'waiting-activity')

	await harness.clock.advance(5 * 60_000)
	harness.foreground = true
	harness.scheduler.onChannelContextChanged()
	await flushMicrotasks()
	assert.equal(harness.scheduler.getSnapshot().status, 'grace-period')
	await harness.clock.advance(FOREGROUND_GRACE_MS - 1)
	assert.equal(harness.calls.length, 0)
	await harness.clock.advance(1)
	assert.equal(harness.calls.length, 1)
	harness.scheduler.stop()
})
