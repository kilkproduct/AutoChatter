import { DEFAULT_SETTINGS, normalizeSettings } from './validation'
import type { JsonStorage } from '@valenced/json-storage'
import type { AutoChatterSettings } from './types'

export type SettingsChangeSource = 'load' | 'user' | 'scheduler'
export type SettingsListener = (
	settings: AutoChatterSettings,
	source: SettingsChangeSource,
) => void

function cloneSettings(settings: AutoChatterSettings): AutoChatterSettings {
	return {
		...settings,
		selectedChannels: [...settings.selectedChannels],
		sendAttempt: settings.sendAttempt ? { ...settings.sendAttempt } : null,
	}
}

/** One serialized writer for the plugin's official per-plugin JSON storage. */
class AutoChatterSettingsStore {
	private storage: JsonStorage<AutoChatterSettings> | undefined
	private current: AutoChatterSettings = cloneSettings(DEFAULT_SETTINGS)
	private ready = false
	private writeQueue: Promise<void> = Promise.resolve()
	private listeners = new Set<SettingsListener>()
	private storageErrorHandler: ((error: unknown) => void) | undefined

	get isReady(): boolean {
		return this.ready
	}

	getSnapshot(): AutoChatterSettings {
		return cloneSettings(this.current)
	}

	setStorageErrorHandler(
		handler: ((error: unknown) => void) | undefined,
	): void {
		this.storageErrorHandler = handler
	}

	subscribe(listener: SettingsListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async load(
		storage: JsonStorage<AutoChatterSettings>,
		now = Date.now(),
	): Promise<AutoChatterSettings> {
		this.storage = storage
		let persisted: unknown
		try {
			persisted = await storage.get()
		} catch {
			// A corrupt JSON document or a read error must recover to a known-safe configuration.
			persisted = storage.cache
		}

		this.current = normalizeSettings(persisted, now, {
			recoverInFlight: true,
		})
		this.ready = true
		this.emit('load')
		try {
			await this.persistSnapshot(this.current)
		} catch {
			// persistSnapshot already reported the failure; keep the repaired in-memory settings usable.
		}
		return this.getSnapshot()
	}

	update(
		patch: Partial<AutoChatterSettings>,
		source: SettingsChangeSource = 'user',
	): Promise<void> {
		const merged: AutoChatterSettings = {
			...this.current,
			...patch,
			selectedChannels: patch.selectedChannels
				? [...patch.selectedChannels]
				: [...this.current.selectedChannels],
			sendAttempt: patch.sendAttempt
				? { ...patch.sendAttempt }
				: patch.sendAttempt === null
					? null
					: this.current.sendAttempt,
		}

		if (
			source === 'user' &&
			patch.enabled === true &&
			!this.current.enabled &&
			merged.lastSuccessfulSendAt === 0 &&
			merged.scheduleStartedAt === 0
		) {
			merged.scheduleStartedAt = Date.now()
		}

		this.current = normalizeSettings(merged, Date.now())
		this.emit(source)
		return this.persistSnapshot(this.current)
	}

	replace(
		settings: AutoChatterSettings,
		source: SettingsChangeSource = 'scheduler',
	): Promise<void> {
		this.current = normalizeSettings(settings, Date.now())
		this.emit(source)
		return this.persistSnapshot(this.current)
	}

	private emit(source: SettingsChangeSource): void {
		const snapshot = this.getSnapshot()
		for (const listener of this.listeners) {
			try {
				listener(snapshot, source)
			} catch (error) {
				this.storageErrorHandler?.(error)
			}
		}
	}

	private persistSnapshot(settings: AutoChatterSettings): Promise<void> {
		const storage = this.storage
		if (!storage) return Promise.resolve()
		const snapshot = cloneSettings(settings)
		const write = this.writeQueue.then(() => storage.set(snapshot, true))
		this.writeQueue = write.catch(error => {
			this.storageErrorHandler?.(error)
		})
		return write
	}
}

export const settingsStore = new AutoChatterSettingsStore()
