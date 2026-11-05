import {
	isValidIntervalSeconds,
	nextSendAt,
	normalizeSettings,
	validateMessage,
} from './validation'
import type {
	AutoChatterSettings,
	ChannelEligibility,
	CurrentChannel,
	SchedulerClock,
	SchedulerSnapshot,
	SchedulerStatus,
	SendAttempt,
	SendOutcome,
} from './types'

export const FOREGROUND_GRACE_MS = 600_000
const MAX_TIMER_CHUNK_MS = 60_000

export interface SchedulerPorts {
	clock: SchedulerClock
	isForeground(): boolean
	getCurrentChannel(): CurrentChannel | null
	inspectChannel(
		channelId: string,
		selectedChannels: readonly string[],
	): ChannelEligibility
	getMessageLimit(): number
	isSendApiAvailable(): boolean
	sendMessage(channelId: string, message: string): Promise<SendOutcome>
	persist(settings: AutoChatterSettings): Promise<void>
	newAttemptId(): string
	log(level: 'warn' | 'error', message: string): void
}

export type SchedulerSnapshotListener = (snapshot: SchedulerSnapshot) => void

const EMPTY_ELIGIBILITY: ChannelEligibility = {
	allowed: false,
	reason: 'no-channel',
}

const INITIAL_SNAPSHOT: SchedulerSnapshot = {
	status: 'disabled',
	statusDetail: 'AutoChatter is disabled.',
	nextSendAt: null,
	graceEndsAt: null,
	currentChannel: null,
	currentChannelEligibility: EMPTY_ELIGIBILITY,
	selectedChannelCount: 0,
	pendingSend: false,
	lastSuccessfulSendAt: 0,
	lastError: null,
	sendAttemptState: null,
	appActive: false,
}

let currentScheduler: AutoChatterScheduler | undefined
const globalListeners = new Set<SchedulerSnapshotListener>()
let lastSnapshot = INITIAL_SNAPSHOT

export function setActiveScheduler(
	scheduler: AutoChatterScheduler | undefined,
): void {
	currentScheduler = scheduler
	lastSnapshot = scheduler?.getSnapshot() ?? INITIAL_SNAPSHOT
	notifyGlobalListeners()
}

export function subscribeToScheduler(
	listener: SchedulerSnapshotListener,
): () => void {
	globalListeners.add(listener)
	listener(lastSnapshot)
	return () => globalListeners.delete(listener)
}

export function getSchedulerSnapshot(): SchedulerSnapshot {
	return lastSnapshot
}

export function retryPendingSend(forceUncertain = false): boolean {
	return currentScheduler?.retryPendingSend(forceUncertain) ?? false
}

export class AutoChatterScheduler {
	private settings: AutoChatterSettings
	private running = false
	private appActive = false
	private timer: ReturnType<typeof setTimeout> | undefined
	private currentAttemptId: string | undefined
	private listeners = new Set<SchedulerSnapshotListener>()
	private storageFailure: string | null = null

	constructor(
		initialSettings: AutoChatterSettings,
		private readonly ports: SchedulerPorts,
	) {
		this.settings = normalizeSettings(initialSettings, ports.clock.now())
	}

	start(sessionId: string, appActive = this.ports.isForeground()): void {
		if (this.running) return
		this.running = true
		this.appActive = appActive

		const now = this.ports.clock.now()
		const previousSessionId = this.settings.runtimeSessionId
		const sessionChanged = previousSessionId !== sessionId
		const next = normalizeSettings(this.settings, now)
		const dueAt = nextSendAt(next)

		if (
			next.enabled &&
			next.lastSuccessfulSendAt === 0 &&
			next.scheduleStartedAt === 0
		) {
			next.scheduleStartedAt = now
		}
		if (!next.pendingSend && dueAt !== null && dueAt <= now) {
			next.pendingSend = true
			next.pendingDueAt = dueAt
			next.requiresGrace = sessionChanged || !appActive
			next.gracePeriodStartedAt = null
		}
		if (next.pendingSend && next.requiresGrace) {
			if (!appActive) {
				next.gracePeriodStartedAt = null
			} else if (sessionChanged || next.gracePeriodStartedAt === null) {
				next.gracePeriodStartedAt = now
			}
		}
		next.runtimeSessionId = sessionId
		this.settings = normalizeSettings(next, now)
		void this.persistCurrent('Could not persist scheduler recovery state.')
		this.publish()
		void this.evaluate('startup', true)
	}

	stop(): void {
		if (!this.running) return
		this.running = false
		this.clearTimer()
		const patch: Partial<AutoChatterSettings> = {
			runtimeSessionId: null,
		}
		if (this.settings.requiresGrace) patch.gracePeriodStartedAt = null
		this.applyPatch(patch)
		void this.persistCurrent(
			'Could not save scheduler state while stopping.',
		)
		this.publish()
	}

	subscribe(listener: SchedulerSnapshotListener): () => void {
		this.listeners.add(listener)
		listener(this.getSnapshot())
		return () => this.listeners.delete(listener)
	}

	getSnapshot(): SchedulerSnapshot {
		const now = this.ports.clock.now()
		const currentChannel = this.safeCurrentChannel()
		const eligibility = currentChannel
			? this.safeInspectChannel(currentChannel.id)
			: EMPTY_ELIGIBILITY
		const dueAt = nextSendAt(this.settings)
		const graceEndsAt =
			this.settings.requiresGrace &&
			this.settings.gracePeriodStartedAt !== null
				? this.settings.gracePeriodStartedAt + FOREGROUND_GRACE_MS
				: null
		const status = this.statusAt(now, dueAt, eligibility, currentChannel)
		const attempt = this.settings.sendAttempt

		return {
			status,
			statusDetail: this.statusDetail(status, eligibility),
			nextSendAt: dueAt,
			graceEndsAt,
			currentChannel,
			currentChannelEligibility: eligibility,
			selectedChannelCount: this.settings.selectedChannels.length,
			pendingSend: this.settings.pendingSend,
			lastSuccessfulSendAt: this.settings.lastSuccessfulSendAt,
			lastError: attempt?.reason ?? this.storageFailure,
			sendAttemptState: attempt?.state ?? null,
			appActive: this.appActive,
		}
	}

	/** Settings edits update the deadline and status, but never invoke the sender directly. */
	updateSettings(settings: AutoChatterSettings): void {
		if (!this.running) return
		this.settings = normalizeSettings(settings, this.ports.clock.now())
		this.storageFailure = null
		if (this.refreshDue(this.ports.clock.now(), false)) {
			void this.persistCurrent(
				'Could not persist an overdue interval after settings changed.',
			)
		}
		this.publish()
		this.scheduleNextTimer()
	}

	onAppStateChange(active: boolean): void {
		if (!this.running) return
		const now = this.ports.clock.now()
		const wasActive = this.appActive
		if (wasActive === active) return

		this.appActive = active
		if (!active) {
			this.refreshDue(now, true)
			if (
				this.settings.requiresGrace &&
				this.settings.gracePeriodStartedAt !== null
			) {
				const graceEndsAt =
					this.settings.gracePeriodStartedAt + FOREGROUND_GRACE_MS
				if (now >= graceEndsAt) {
					this.applyPatch({
						requiresGrace: false,
						gracePeriodStartedAt: null,
					})
				} else {
					this.applyPatch({ gracePeriodStartedAt: null })
				}
			}
			this.clearTimer()
			void this.persistCurrent(
				'Could not persist the background transition.',
			)
			this.publish()
			return
		}

		const dueStateChanged = this.refreshDue(now, !wasActive)
		if (dueStateChanged) {
			void this.persistCurrent(
				'Could not persist the overdue send after foregrounding.',
			)
		}
		if (
			this.settings.pendingSend &&
			this.settings.requiresGrace &&
			this.settings.gracePeriodStartedAt === null
		) {
			this.applyPatch({ gracePeriodStartedAt: now })
			void this.persistCurrent(
				'Could not persist the foreground grace period.',
			)
		}
		void this.evaluate('foreground', true)
	}

	onChannelContextChanged(): void {
		if (!this.running) return
		void this.evaluate('channel-change', true)
	}

	onMessagingAvailable(): void {
		if (!this.running) return
		void this.evaluate('messaging-ready', true)
	}

	retryPendingSend(forceUncertain = false): boolean {
		if (
			!this.running ||
			!this.settings.enabled ||
			!this.settings.pendingSend
		)
			return false
		const state = this.settings.sendAttempt?.state
		if (state === 'in-flight') return false
		if (state === 'uncertain' && !forceUncertain) return false
		void this.evaluate('manual-retry', true, true)
		return true
	}

	private async evaluate(
		reason:
			| 'startup'
			| 'timer'
			| 'foreground'
			| 'channel-change'
			| 'messaging-ready'
			| 'manual-retry',
		allowSend: boolean,
		forceRetry = false,
	): Promise<void> {
		if (!this.running) return
		const foregroundNow = this.ports.isForeground()
		if (foregroundNow !== this.appActive) {
			this.onAppStateChange(foregroundNow)
			return
		}
		this.appActive = foregroundNow
		const now = this.ports.clock.now()
		if (this.refreshDue(now, reason === 'foreground')) {
			void this.persistCurrent(
				'Could not persist the overdue interval state.',
			)
		}

		if (!this.settings.enabled || !this.appActive) {
			this.publish()
			this.scheduleNextTimer()
			return
		}

		if (this.settings.pendingSend && this.settings.requiresGrace) {
			const startedAt = this.settings.gracePeriodStartedAt
			if (startedAt === null) {
				this.applyPatch({ gracePeriodStartedAt: now })
				void this.persistCurrent(
					'Could not persist the foreground grace period.',
				)
				this.publish()
				this.scheduleNextTimer()
				return
			}
			if (now < startedAt + FOREGROUND_GRACE_MS) {
				this.publish()
				this.scheduleNextTimer()
				return
			}
			this.applyPatch({
				requiresGrace: false,
				gracePeriodStartedAt: null,
			})
			void this.persistCurrent(
				'Could not persist completion of the foreground grace period.',
			)
		}

		const attempt = this.settings.sendAttempt
		if (attempt?.state === 'in-flight') {
			this.publish()
			this.scheduleNextTimer()
			return
		}
		if (attempt && !forceRetry) {
			this.publish()
			this.scheduleNextTimer()
			return
		}

		if (this.settings.pendingSend && allowSend) {
			await this.trySend(reason, forceRetry)
			return
		}

		this.publish()
		this.scheduleNextTimer()
	}

	private refreshDue(now: number, dueWhileInactive: boolean): boolean {
		const dueAt = nextSendAt(this.settings)
		if (dueAt === null) return false

		if (
			this.settings.pendingSend &&
			!this.settings.sendAttempt &&
			dueAt > now
		) {
			this.applyPatch({
				pendingSend: false,
				pendingDueAt: null,
				requiresGrace: false,
				gracePeriodStartedAt: null,
			})
			return true
		}

		if (!this.settings.pendingSend && dueAt <= now) {
			const requiresGrace = dueWhileInactive || !this.appActive
			this.applyPatch({
				pendingSend: true,
				pendingDueAt: dueAt,
				requiresGrace,
				gracePeriodStartedAt:
					requiresGrace && this.appActive ? now : null,
			})
			return true
		}

		if (this.settings.pendingSend && this.settings.pendingDueAt !== dueAt) {
			this.applyPatch({ pendingDueAt: dueAt })
			return true
		}
		return false
	}

	private async trySend(reason: string, forceRetry: boolean): Promise<void> {
		if (
			!this.running ||
			!this.settings.enabled ||
			!this.appActive ||
			!this.settings.pendingSend
		) {
			this.publish()
			return
		}
		const existingAttempt = this.settings.sendAttempt
		if (existingAttempt && !forceRetry) return
		if (existingAttempt?.state === 'in-flight') return

		if (!isValidIntervalSeconds(this.settings.intervalSeconds)) {
			this.settings = normalizeSettings(
				this.settings,
				this.ports.clock.now(),
			)
			void this.persistCurrent(
				'An invalid interval was repaired before scheduling.',
			)
		}

		const message = this.settings.message
		const messageValidation = validateMessage(
			message,
			this.ports.getMessageLimit(),
		)
		if (!messageValidation.valid) {
			this.publish()
			return
		}
		if (!this.ports.isSendApiAvailable()) {
			this.publish()
			return
		}

		const channel = this.safeCurrentChannel()
		if (!channel) {
			this.publish()
			return
		}
		const eligibility = this.safeInspectChannel(channel.id)
		if (!eligibility.allowed) {
			this.publish()
			return
		}

		const attempt: SendAttempt = {
			id: this.ports.newAttemptId(),
			startedAt: this.ports.clock.now(),
			state: 'in-flight',
		}
		this.currentAttemptId = attempt.id
		this.applyPatch({ sendAttempt: attempt })
		this.publish()

		if (
			!(await this.persistCurrent(
				'Could not safely record the send attempt; no message was sent.',
			))
		) {
			this.applyPatch({
				sendAttempt: {
					...attempt,
					state: 'failed',
					failureKind: 'rejected',
					reason: 'The send attempt could not be saved. No message was sent.',
				},
			})
			this.currentAttemptId = undefined
			this.publish()
			return
		}

		if (!this.running || this.currentAttemptId !== attempt.id) return
		try {
			this.appActive = this.ports.isForeground()
		} catch {
			this.appActive = false
		}
		const currentChannel = this.safeCurrentChannel()
		const currentEligibility = currentChannel
			? this.safeInspectChannel(currentChannel.id)
			: EMPTY_ELIGIBILITY
		const messageStillValid = validateMessage(
			message,
			this.ports.getMessageLimit(),
		).valid
		if (
			!this.appActive ||
			!this.settings.enabled ||
			!this.settings.pendingSend ||
			this.settings.requiresGrace ||
			this.settings.sendAttempt?.id !== attempt.id ||
			!currentChannel ||
			currentChannel.id !== channel.id ||
			!currentEligibility.allowed ||
			!this.settings.selectedChannels.includes(channel.id) ||
			this.settings.message !== message ||
			!messageStillValid ||
			!this.ports.isSendApiAvailable()
		) {
			this.currentAttemptId = undefined
			this.applyPatch({ sendAttempt: null })
			void this.persistCurrent(
				'Could not clear a send attempt after navigation changed.',
			)
			this.publish()
			return
		}

		let outcome: SendOutcome
		try {
			outcome = await this.ports.sendMessage(channel.id, message)
		} catch (error) {
			const reasonText =
				error instanceof Error ? error.name : 'Unknown error'
			outcome = {
				kind: 'uncertain',
				reason: `${reasonText}; delivery was not confirmed.`,
			}
		}

		if (this.currentAttemptId !== attempt.id) return
		this.currentAttemptId = undefined
		this.applySendOutcome(attempt, outcome)
		await this.persistCurrent(
			'Could not persist the result of the send attempt.',
		)
		this.publish()
		if (outcome.kind === 'confirmed') {
			this.ports.log(
				'warn',
				`Message sent in the selected current channel after ${reason}.`,
			)
			this.scheduleNextTimer()
		} else if (outcome.kind === 'rejected') {
			this.ports.log(
				'error',
				`Discord refused an AutoChatter send${outcome.status ? ` (HTTP ${outcome.status})` : ''}. No automatic retry was scheduled.`,
			)
		} else if (outcome.kind === 'uncertain') {
			this.ports.log(
				'error',
				'AutoChatter could not confirm delivery. The pending send is held to prevent an automatic duplicate.',
			)
		} else {
			this.ports.log(
				'warn',
				'Discord message actions became unavailable. The pending send was retained without retrying.',
			)
		}
	}

	private applySendOutcome(attempt: SendAttempt, outcome: SendOutcome): void {
		if (outcome.kind === 'confirmed') {
			const sentAt = Math.max(
				this.ports.clock.now(),
				this.settings.lastSuccessfulSendAt,
			)
			this.applyPatch({
				lastSuccessfulSendAt: sentAt,
				scheduleStartedAt: 0,
				pendingSend: false,
				pendingDueAt: null,
				requiresGrace: false,
				gracePeriodStartedAt: null,
				sendAttempt: null,
			})
			return
		}

		if (outcome.kind === 'unavailable') {
			this.applyPatch({ sendAttempt: null })
			return
		}

		if (outcome.kind === 'rejected') {
			this.applyPatch({
				sendAttempt: {
					...attempt,
					state: 'failed',
					failureKind: 'rejected',
					httpStatus: outcome.status,
					reason:
						outcome.reason ??
						(outcome.status
							? `Discord returned HTTP ${outcome.status}.`
							: 'Discord refused the message.'),
				},
			})
			return
		}

		this.applyPatch({
			sendAttempt: {
				...attempt,
				state: 'uncertain',
				failureKind: 'uncertain',
				reason:
					outcome.reason ??
					'Delivery was not confirmed; the message was not retried.',
			},
		})
	}

	private applyPatch(patch: Partial<AutoChatterSettings>): void {
		const merged: AutoChatterSettings = {
			...this.settings,
			...patch,
			selectedChannels: patch.selectedChannels
				? [...patch.selectedChannels]
				: this.settings.selectedChannels,
			sendAttempt: patch.sendAttempt
				? { ...patch.sendAttempt }
				: patch.sendAttempt === null
					? null
					: this.settings.sendAttempt,
		}
		this.settings = normalizeSettings(merged, this.ports.clock.now())
	}

	private async persistCurrent(errorMessage: string): Promise<boolean> {
		try {
			await this.ports.persist(this.copySettings())
			this.storageFailure = null
			return true
		} catch {
			this.storageFailure = errorMessage
			this.ports.log('error', errorMessage)
			return false
		}
	}

	private copySettings(): AutoChatterSettings {
		return {
			...this.settings,
			selectedChannels: [...this.settings.selectedChannels],
			sendAttempt: this.settings.sendAttempt
				? { ...this.settings.sendAttempt }
				: null,
		}
	}

	private statusAt(
		now: number,
		dueAt: number | null,
		eligibility: ChannelEligibility,
		currentChannel: CurrentChannel | null,
	): SchedulerStatus {
		if (!this.settings.enabled) return 'disabled'
		if (this.settings.sendAttempt?.state === 'in-flight') return 'sending'
		if (this.settings.sendAttempt) return 'send-failed'
		if (
			!this.appActive &&
			(this.settings.pendingSend || (dueAt !== null && dueAt <= now))
		) {
			return 'waiting-activity'
		}
		if (!this.settings.pendingSend && dueAt !== null && dueAt > now)
			return 'waiting-interval'
		if (this.settings.pendingSend && this.settings.requiresGrace) {
			const graceStartedAt = this.settings.gracePeriodStartedAt
			if (
				graceStartedAt === null ||
				now < graceStartedAt + FOREGROUND_GRACE_MS
			) {
				return 'grace-period'
			}
		}
		if (!this.settings.pendingSend) return 'waiting-interval'
		if (
			!validateMessage(
				this.settings.message,
				this.ports.getMessageLimit(),
			).valid
		) {
			return 'invalid-message'
		}
		if (!currentChannel || !eligibility.allowed) return 'waiting-channel'
		if (!this.ports.isSendApiAvailable()) return 'send-unavailable'
		return 'ready'
	}

	private statusDetail(
		status: SchedulerStatus,
		eligibility: ChannelEligibility,
	): string {
		switch (status) {
			case 'disabled':
				return 'AutoChatter is disabled.'
			case 'waiting-interval':
				return 'The global interval is running from the last successful send.'
			case 'waiting-activity':
				return 'The overdue send is waiting for Valenced to be foregrounded.'
			case 'grace-period':
				return 'Keep Valenced continuously in the foreground for ten minutes.'
			case 'waiting-channel':
				return this.channelReason(eligibility)
			case 'ready':
				return 'The currently viewed channel is selected and sendable.'
			case 'sending':
				return 'The configured messaging adapter is processing this attempt.'
			case 'send-failed':
				return (
					this.settings.sendAttempt?.reason ??
					'The pending message is held; no automatic retry will run.'
				)
			case 'send-unavailable':
				return 'No message was sent: Valenced has not confirmed a supported plugin messaging API.'
			case 'invalid-message':
				return 'The configured message is empty or exceeds the current Discord limit.'
		}
	}

	private channelReason(eligibility: ChannelEligibility): string {
		switch (eligibility.reason) {
			case 'no-channel':
				return 'Open a channel you explicitly selected.'
			case 'not-selected':
				return 'The current channel is not selected; no other channel will be used.'
			case 'inaccessible':
				return 'The current channel is no longer accessible; choose another selected channel.'
			case 'no-send-permission':
				return 'Discord does not currently allow sending in the current channel.'
			case 'unsupported-channel':
				return 'The current channel does not support plain-text messages.'
			case 'eligible':
				return 'The current channel is eligible.'
		}
	}

	private safeCurrentChannel(): CurrentChannel | null {
		try {
			return this.ports.getCurrentChannel()
		} catch {
			return null
		}
	}

	private safeInspectChannel(channelId: string): ChannelEligibility {
		try {
			return this.ports.inspectChannel(
				channelId,
				this.settings.selectedChannels,
			)
		} catch {
			return { allowed: false, reason: 'inaccessible' }
		}
	}

	private scheduleNextTimer(): void {
		this.clearTimer()
		if (!this.running || !this.appActive || !this.settings.enabled) return
		if (this.settings.sendAttempt) return

		const now = this.ports.clock.now()
		let delay: number | null = null
		if (this.settings.pendingSend && this.settings.requiresGrace) {
			const startedAt = this.settings.gracePeriodStartedAt
			if (startedAt !== null) {
				delay = Math.max(0, startedAt + FOREGROUND_GRACE_MS - now)
			}
		} else if (!this.settings.pendingSend) {
			const dueAt = nextSendAt(this.settings)
			if (dueAt !== null) delay = Math.max(0, dueAt - now)
		}
		if (delay === null) return

		const wait = Math.min(delay, MAX_TIMER_CHUNK_MS)
		this.timer = this.ports.clock.setTimeout(() => {
			this.timer = undefined
			void this.evaluate('timer', true)
		}, wait)
	}

	private clearTimer(): void {
		if (this.timer === undefined) return
		this.ports.clock.clearTimeout(this.timer)
		this.timer = undefined
	}

	private publish(): void {
		const snapshot = this.getSnapshot()
		if (currentScheduler === this) {
			lastSnapshot = snapshot
			notifyGlobalListeners()
		}
		for (const listener of this.listeners) {
			try {
				listener(snapshot)
			} catch {
				// A settings-view listener cannot stop scheduler bookkeeping.
			}
		}
	}
}

function notifyGlobalListeners(): void {
	for (const listener of globalListeners) {
		try {
			listener(lastSnapshot)
		} catch {
			// A UI subscriber must not affect the single global schedule.
		}
	}
}
