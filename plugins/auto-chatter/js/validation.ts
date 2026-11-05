import { PLUGIN_ID, SETTINGS_SCHEMA_VERSION } from './types'
import type { AutoChatterSettings, MessagePreset, SendAttempt } from './types'

export const DEFAULT_INTERVAL_SECONDS = 7_200
export const MIN_INTERVAL_SECONDS = 600
export const DEFAULT_MESSAGE = 'Meow\n\nmrrrp meow meow'
export const DEFAULT_MESSAGE_PRESET: MessagePreset = 'meow'
export const DEFAULT_DISCORD_MESSAGE_LIMIT = 2_000
export const OBSERVED_MAX_DISCORD_MESSAGE_LIMIT = 4_000

export const DEFAULT_SETTINGS: AutoChatterSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	enabled: false,
	message: DEFAULT_MESSAGE,
	messagePreset: DEFAULT_MESSAGE_PRESET,
	intervalSeconds: DEFAULT_INTERVAL_SECONDS,
	selectedChannels: [],
	lastSuccessfulSendAt: 0,
	scheduleStartedAt: 0,
	pendingSend: false,
	pendingDueAt: null,
	requiresGrace: false,
	gracePeriodStartedAt: null,
	sendAttempt: null,
	runtimeSessionId: null,
}

export interface ValidationResult<T> {
	valid: boolean
	value?: T
	error?: string
}

export function isValidIntervalSeconds(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= MIN_INTERVAL_SECONDS
	)
}

/** Accept only decimal whole-number input; scientific notation and fractions are rejected. */
export function parseIntervalSeconds(input: string): ValidationResult<number> {
	const value = input.trim()
	if (!/^\d+$/.test(value)) {
		return { valid: false, error: 'Enter a whole number of seconds.' }
	}

	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) {
		return {
			valid: false,
			error: 'This number is outside JavaScript’s exact integer range.',
		}
	}
	if (parsed < MIN_INTERVAL_SECONDS) {
		return {
			valid: false,
			error: `The interval must be at least ${MIN_INTERVAL_SECONDS} seconds.`,
		}
	}

	return { valid: true, value: parsed }
}

export function normalizeIntervalSeconds(value: unknown): number {
	return isValidIntervalSeconds(value) ? value : DEFAULT_INTERVAL_SECONDS
}

export function validateMessage(
	message: unknown,
	maxLength = DEFAULT_DISCORD_MESSAGE_LIMIT,
): ValidationResult<string> {
	if (typeof message !== 'string' || message.trim().length === 0) {
		return {
			valid: false,
			error: 'Enter a message before enabling AutoChatter.',
		}
	}

	const limit =
		Number.isSafeInteger(maxLength) && maxLength > 0
			? maxLength
			: DEFAULT_DISCORD_MESSAGE_LIMIT
	if (message.length > limit) {
		return {
			valid: false,
			error: `This message is ${message.length - limit} characters over Discord’s ${limit}-character limit.`,
		}
	}

	return { valid: true, value: message }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function validTimestamp(value: unknown): number {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: 0
}

function validOptionalTimestamp(value: unknown): number | null {
	if (value === null || value === undefined) return null
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: null
}

function validChannelIds(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const ids = new Set<string>()
	for (const item of value) {
		if (typeof item === 'string' && /^\d{1,22}$/.test(item)) ids.add(item)
	}
	return [...ids]
}

function validSendAttempt(
	value: unknown,
	recoverInFlight: boolean,
): SendAttempt | null {
	const record = asRecord(value)
	if (!record || typeof record.id !== 'string' || !record.id) return null
	if (
		record.state !== 'in-flight' &&
		record.state !== 'failed' &&
		record.state !== 'uncertain'
	) {
		return null
	}

	const attempt: SendAttempt = {
		id: record.id,
		startedAt: validTimestamp(record.startedAt),
		state:
			recoverInFlight && record.state === 'in-flight'
				? 'uncertain'
				: record.state,
	}
	if (
		record.failureKind === 'rejected' ||
		record.failureKind === 'uncertain'
	) {
		attempt.failureKind = record.failureKind
	}
	if (
		typeof record.httpStatus === 'number' &&
		Number.isInteger(record.httpStatus)
	) {
		attempt.httpStatus = record.httpStatus
	}
	if (typeof record.reason === 'string')
		attempt.reason = record.reason.slice(0, 240)
	if (recoverInFlight && record.state === 'in-flight') {
		attempt.failureKind = 'uncertain'
		attempt.reason =
			'The previous send ended before its result was recorded.'
	}
	return attempt
}

/**
 * Repair a loaded or runtime settings object. The scheduler calls this independently of the UI,
 * so an invalid persisted interval can never reach a timer calculation.
 */
export function normalizeSettings(
	value: unknown,
	now = Date.now(),
	options: { recoverInFlight?: boolean } = {},
): AutoChatterSettings {
	const record = asRecord(value)
	if (!record) return { ...DEFAULT_SETTINGS, selectedChannels: [] }

	const rawMessage = record.message
	const message =
		typeof rawMessage === 'string' &&
		rawMessage.trim().length > 0 &&
		rawMessage.length <= OBSERVED_MAX_DISCORD_MESSAGE_LIMIT
			? rawMessage
			: DEFAULT_MESSAGE
	const preset: MessagePreset =
		record.messagePreset === 'meow' ||
		(record.messagePreset === undefined && message === DEFAULT_MESSAGE)
			? 'meow'
			: 'custom'
	let lastSuccessfulSendAt = validTimestamp(record.lastSuccessfulSendAt)
	if (lastSuccessfulSendAt > now && now > 0) lastSuccessfulSendAt = now
	let scheduleStartedAt = validTimestamp(record.scheduleStartedAt)
	if (scheduleStartedAt > now && now > 0) scheduleStartedAt = now

	const sendAttempt = validSendAttempt(
		record.sendAttempt,
		options.recoverInFlight === true,
	)
	const pendingSend = record.pendingSend === true || sendAttempt !== null
	const pendingDueAt = validOptionalTimestamp(record.pendingDueAt)
	const requiresGrace = record.requiresGrace === true && pendingSend
	let gracePeriodStartedAt = validOptionalTimestamp(
		record.gracePeriodStartedAt,
	)
	if (!pendingSend || !requiresGrace) gracePeriodStartedAt = null
	if (
		pendingSend &&
		requiresGrace &&
		gracePeriodStartedAt !== null &&
		gracePeriodStartedAt > now
	) {
		gracePeriodStartedAt = now
	}

	const enabled =
		typeof record.enabled === 'boolean'
			? record.enabled
			: DEFAULT_SETTINGS.enabled
	if (
		enabled &&
		lastSuccessfulSendAt === 0 &&
		scheduleStartedAt === 0 &&
		now > 0
	) {
		scheduleStartedAt = now
	}

	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		enabled,
		message,
		messagePreset: preset,
		intervalSeconds: normalizeIntervalSeconds(record.intervalSeconds),
		selectedChannels: validChannelIds(record.selectedChannels),
		lastSuccessfulSendAt,
		scheduleStartedAt,
		pendingSend,
		pendingDueAt,
		requiresGrace,
		gracePeriodStartedAt,
		sendAttempt,
		runtimeSessionId:
			typeof record.runtimeSessionId === 'string' &&
			record.runtimeSessionId.length > 0
				? record.runtimeSessionId.slice(0, 120)
				: null,
	}
}

export function nextSendAt(settings: AutoChatterSettings): number | null {
	const base =
		settings.lastSuccessfulSendAt > 0
			? settings.lastSuccessfulSendAt
			: settings.scheduleStartedAt
	if (base <= 0) return null

	const deadline = base + settings.intervalSeconds * 1_000
	return Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY
}

export function formatInterval(seconds: number): string {
	const safeSeconds = isValidIntervalSeconds(seconds)
		? seconds
		: DEFAULT_INTERVAL_SECONDS
	const units: Array<[string, number]> = [
		['day', 86_400],
		['hour', 3_600],
		['minute', 60],
		['second', 1],
	]
	let remaining = safeSeconds
	const parts: string[] = []
	for (const [name, divisor] of units) {
		const count = Math.floor(remaining / divisor)
		if (count > 0) {
			parts.push(`${count} ${name}${count === 1 ? '' : 's'}`)
			remaining %= divisor
			if (parts.length === 2) break
		}
	}
	return parts.join(' ')
}

export function formatTimeRemaining(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Due now'
	const seconds = Math.ceil(milliseconds / 1_000)
	const units: Array<[string, number]> = [
		['day', 86_400],
		['hour', 3_600],
		['minute', 60],
	]
	let remaining = seconds
	const parts: string[] = []
	for (const [name, divisor] of units) {
		const count = Math.floor(remaining / divisor)
		if (count > 0) {
			parts.push(`${count} ${name}${count === 1 ? '' : 's'}`)
			remaining %= divisor
			if (parts.length === 2) break
		}
	}
	if (parts.length === 0) return 'Less than a minute'
	return `In ${parts.join(' ')}`
}

export function formatTimestamp(timestamp: number): string {
	if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
		return 'Not sent yet'
	try {
		const date = new Date(timestamp)
		if (Number.isNaN(date.getTime())) return 'Unavailable'
		return date.toLocaleString()
	} catch {
		return 'Unavailable'
	}
}

export function createRuntimeSessionId(now = Date.now()): string {
	return `${PLUGIN_ID}:${now.toString(36)}:${Math.random().toString(36).slice(2, 10)}`
}
