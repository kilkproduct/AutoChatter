import assert from 'node:assert/strict'
import test from 'node:test'
import {
	DEFAULT_DISCORD_MESSAGE_LIMIT,
	DEFAULT_INTERVAL_SECONDS,
	DEFAULT_MESSAGE,
	DEFAULT_SETTINGS,
	formatInterval,
	isValidIntervalSeconds,
	MIN_INTERVAL_SECONDS,
	nextSendAt,
	normalizeIntervalSeconds,
	normalizeSettings,
	parseIntervalSeconds,
	validateMessage,
} from '../plugins/auto-chatter/js/validation'

test('interval input accepts whole seconds from 600 upward without an app max', () => {
	assert.equal(parseIntervalSeconds('600').value, 600)
	assert.equal(parseIntervalSeconds(' 7200 ').value, 7_200)
	assert.equal(parseIntervalSeconds('864000000').value, 864_000_000)
	assert.equal(
		parseIntervalSeconds(String(Number.MAX_SAFE_INTEGER)).value,
		Number.MAX_SAFE_INTEGER,
	)
	assert.equal(parseIntervalSeconds('599').valid, false)
	assert.equal(parseIntervalSeconds('600.1').valid, false)
	assert.equal(parseIntervalSeconds('1e6').valid, false)
	assert.equal(parseIntervalSeconds('Infinity').valid, false)
	assert.equal(
		parseIntervalSeconds(String(Number.MAX_SAFE_INTEGER + 1)).valid,
		false,
	)
})

test('persisted invalid intervals repair to the 7200-second default', () => {
	for (const value of [
		undefined,
		null,
		'',
		'600',
		0,
		-1,
		599,
		600.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		assert.equal(normalizeIntervalSeconds(value), DEFAULT_INTERVAL_SECONDS)
		assert.equal(
			normalizeSettings(
				{ ...DEFAULT_SETTINGS, intervalSeconds: value },
				10_000,
			).intervalSeconds,
			DEFAULT_INTERVAL_SECONDS,
		)
	}
	assert.equal(
		normalizeSettings({ ...DEFAULT_SETTINGS, intervalSeconds: 600 }, 10_000)
			.intervalSeconds,
		600,
	)
	assert.equal(
		normalizeSettings(
			{ ...DEFAULT_SETTINGS, intervalSeconds: 86_400_000 },
			10_000,
		).intervalSeconds,
		86_400_000,
	)
	assert.equal(isValidIntervalSeconds(MIN_INTERVAL_SECONDS), true)
	assert.equal(isValidIntervalSeconds(599), false)
})

test('new and corrupt settings recover to disabled, unselected safe defaults', () => {
	const missing = normalizeSettings(undefined, 5_000)
	assert.equal(missing.enabled, false)
	assert.equal(missing.intervalSeconds, DEFAULT_INTERVAL_SECONDS)
	assert.equal(missing.message, 'Meow\n\nmrrrp meow meow')
	assert.deepEqual(missing.selectedChannels, [])

	const repaired = normalizeSettings(
		{
			enabled: 'yes',
			message: '   ',
			intervalSeconds: Number.NaN,
			selectedChannels: [
				'123456789012345678',
				'not-a-channel',
				12,
				'123456789012345678',
			],
			lastSuccessfulSendAt: -8,
			scheduleStartedAt: Number.POSITIVE_INFINITY,
			pendingSend: 'true',
			requiresGrace: true,
			gracePeriodStartedAt: -1,
		},
		5_000,
	)
	assert.equal(repaired.enabled, false)
	assert.equal(repaired.message, DEFAULT_MESSAGE)
	assert.equal(repaired.intervalSeconds, DEFAULT_INTERVAL_SECONDS)
	assert.deepEqual(repaired.selectedChannels, ['123456789012345678'])
	assert.equal(repaired.lastSuccessfulSendAt, 0)
	assert.equal(repaired.scheduleStartedAt, 0)
	assert.equal(repaired.pendingSend, false)
	assert.equal(repaired.requiresGrace, false)
	assert.equal(repaired.gracePeriodStartedAt, null)
})

test('loaded in-flight attempts recover as uncertain and are never silently retried', () => {
	const recovered = normalizeSettings(
		{
			...DEFAULT_SETTINGS,
			enabled: true,
			pendingSend: true,
			sendAttempt: {
				id: 'attempt-1',
				startedAt: 4_000,
				state: 'in-flight',
			},
		},
		5_000,
		{ recoverInFlight: true },
	)
	assert.equal(recovered.pendingSend, true)
	assert.equal(recovered.sendAttempt?.state, 'uncertain')
	assert.equal(recovered.sendAttempt?.failureKind, 'uncertain')
	assert.match(recovered.sendAttempt?.reason ?? '', /previous send ended/)
})

test('message validation preserves exact plain text and enforces the configured limit', () => {
	assert.equal(validateMessage(DEFAULT_MESSAGE).valid, true)
	assert.equal(validateMessage('hello\n\nworld').value, 'hello\n\nworld')
	assert.equal(validateMessage('  \n ').valid, false)
	assert.equal(
		validateMessage('x'.repeat(DEFAULT_DISCORD_MESSAGE_LIMIT)).valid,
		true,
	)
	assert.equal(
		validateMessage('x'.repeat(DEFAULT_DISCORD_MESSAGE_LIMIT + 1)).valid,
		false,
	)
	assert.equal(validateMessage('hello', 4).valid, false)
})

test('the global deadline is anchored to last successful send, otherwise enable time', () => {
	const intervalMs = 600_000
	assert.equal(
		nextSendAt({
			...DEFAULT_SETTINGS,
			intervalSeconds: 600,
			scheduleStartedAt: 1_000,
		}),
		1_000 + intervalMs,
	)
	assert.equal(
		nextSendAt({
			...DEFAULT_SETTINGS,
			intervalSeconds: 600,
			scheduleStartedAt: 1_000,
			lastSuccessfulSendAt: 2_000,
		}),
		2_000 + intervalMs,
	)
	assert.equal(
		nextSendAt({
			...DEFAULT_SETTINGS,
			scheduleStartedAt: 0,
			lastSuccessfulSendAt: 0,
		}),
		null,
	)
})

test('human interval formatting handles exact minimum and long intervals', () => {
	assert.equal(formatInterval(600), '10 minutes')
	assert.equal(formatInterval(7_200), '2 hours')
	assert.equal(formatInterval(90_061), '1 day 1 hour')
})
