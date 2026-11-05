import assert from 'node:assert/strict'
import test from 'node:test'
import { settingsStore } from '../plugins/auto-chatter/js/storage'
import {
	DEFAULT_INTERVAL_SECONDS,
	DEFAULT_SETTINGS,
} from '../plugins/auto-chatter/js/validation'
import type { JsonStorage } from '@valenced/json-storage'
import type { AutoChatterSettings } from '../plugins/auto-chatter/js/types'

function fakeStorage(
	initial: unknown,
	options: { rejectRead?: boolean; writeDelayMs?: number } = {},
): {
	storage: JsonStorage<AutoChatterSettings>
	writes: AutoChatterSettings[]
	maxConcurrentWrites: () => number
} {
	const writes: AutoChatterSettings[] = []
	let activeWrites = 0
	let maximum = 0
	const storage = {
		cache: initial as AutoChatterSettings,
		loaded: true,
		get: async () => {
			if (options.rejectRead) throw new Error('simulated corrupt JSON')
			return initial as AutoChatterSettings
		},
		set: async (value: AutoChatterSettings) => {
			activeWrites++
			maximum = Math.max(maximum, activeWrites)
			if (options.writeDelayMs) {
				await new Promise(resolve =>
					setTimeout(resolve, options.writeDelayMs),
				)
			}
			writes.push({
				...value,
				selectedChannels: [...value.selectedChannels],
			})
			activeWrites--
		},
		subscribe: () => () => undefined,
		use: () => undefined,
	}
	return {
		storage: storage as unknown as JsonStorage<AutoChatterSettings>,
		writes,
		maxConcurrentWrites: () => maximum,
	}
}

test('loading repairs corrupt persisted values and replaces the stored document', async () => {
	const { storage, writes } = fakeStorage({
		...DEFAULT_SETTINGS,
		intervalSeconds: 0,
		selectedChannels: ['not-a-snowflake'],
		scheduleStartedAt: -1,
	})
	const loaded = await settingsStore.load(storage, 10_000)
	assert.equal(loaded.intervalSeconds, DEFAULT_INTERVAL_SECONDS)
	assert.deepEqual(loaded.selectedChannels, [])
	assert.equal(loaded.scheduleStartedAt, 0)
	assert.equal(writes.length, 1)
	assert.equal(writes[0]?.intervalSeconds, DEFAULT_INTERVAL_SECONDS)
})

test('a storage read/parse failure recovers from cache without rejecting plugin startup', async () => {
	const cached = { ...DEFAULT_SETTINGS, intervalSeconds: Number.NaN }
	const { storage, writes } = fakeStorage(cached, { rejectRead: true })
	const loaded = await settingsStore.load(storage, 20_000)
	assert.equal(loaded.intervalSeconds, DEFAULT_INTERVAL_SECONDS)
	assert.equal(loaded.enabled, false)
	assert.equal(writes.length, 1)
})

test('concurrent setting edits serialize JSON writes', async () => {
	const { storage, writes, maxConcurrentWrites } = fakeStorage(
		DEFAULT_SETTINGS,
		{ writeDelayMs: 2 },
	)
	await settingsStore.load(storage, 30_000)
	writes.length = 0

	await Promise.all([
		settingsStore.update({ intervalSeconds: 900 }, 'user'),
		settingsStore.update(
			{ message: 'Custom saved text', messagePreset: 'custom' },
			'user',
		),
	])
	assert.equal(maxConcurrentWrites(), 1)
	assert.equal(writes.length, 2)
	assert.equal(writes[0]?.intervalSeconds, 900)
	assert.equal(writes[1]?.message, 'Custom saved text')
	assert.equal(settingsStore.getSnapshot().intervalSeconds, 900)
})
