import { AppState } from 'react-native'

export function isAppForegrounded(): boolean {
	return AppState.currentState === 'active'
}

/** AppState, not plugin start/stop, is the foreground signal used by the scheduler. */
export function subscribeToAppState(
	onForegroundChange: (active: boolean) => void,
): () => void {
	const subscription = AppState.addEventListener('change', state => {
		onForegroundChange(state === 'active')
	})
	return () => subscription.remove()
}
