export const PLUGIN_ID = 'dev.kilkproduct.auto-chatter' as const
export const SETTINGS_SCHEMA_VERSION = 1 as const

export type MessagePreset = 'meow' | 'custom'

export type SendAttemptState = 'in-flight' | 'failed' | 'uncertain'

export interface SendAttempt {
	id: string
	startedAt: number
	state: SendAttemptState
	failureKind?: 'rejected' | 'uncertain'
	httpStatus?: number
	reason?: string
}

/** Persisted settings and the one global scheduler's recovery state. */
export interface AutoChatterSettings {
	schemaVersion: typeof SETTINGS_SCHEMA_VERSION
	enabled: boolean
	message: string
	messagePreset: MessagePreset
	intervalSeconds: number
	selectedChannels: string[]
	lastSuccessfulSendAt: number
	scheduleStartedAt: number
	pendingSend: boolean
	pendingDueAt: number | null
	requiresGrace: boolean
	gracePeriodStartedAt: number | null
	sendAttempt: SendAttempt | null
	runtimeSessionId: string | null
}

export type ChannelEligibilityReason =
	| 'eligible'
	| 'no-channel'
	| 'not-selected'
	| 'inaccessible'
	| 'no-send-permission'
	| 'unsupported-channel'

export interface CurrentChannel {
	id: string
	label: string
}

export interface ChannelEligibility {
	allowed: boolean
	reason: ChannelEligibilityReason
}

export type SchedulerStatus =
	| 'disabled'
	| 'waiting-interval'
	| 'waiting-activity'
	| 'grace-period'
	| 'waiting-channel'
	| 'ready'
	| 'sending'
	| 'send-failed'
	| 'send-unavailable'
	| 'invalid-message'

export interface SchedulerSnapshot {
	status: SchedulerStatus
	statusDetail: string
	nextSendAt: number | null
	graceEndsAt: number | null
	currentChannel: CurrentChannel | null
	currentChannelEligibility: ChannelEligibility
	selectedChannelCount: number
	pendingSend: boolean
	lastSuccessfulSendAt: number
	lastError: string | null
	sendAttemptState: SendAttemptState | null
	appActive: boolean
}

export type SendOutcome =
	| { kind: 'confirmed'; messageId?: string }
	| { kind: 'rejected'; status?: number; reason?: string }
	| { kind: 'uncertain'; reason?: string }
	| { kind: 'unavailable'; reason?: string }

export interface SchedulerClock {
	now(): number
	setTimeout(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>
	clearTimeout(handle: ReturnType<typeof setTimeout>): void
}
