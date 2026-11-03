const ONLINE = new Set(['online', 'ready', 'connected']);
const ACTIVITIES = new Set(['idle', 'thinking', 'talking', 'sleeping']);
export function initialPresentation() { return { activity: 'idle', connectionStatus: 'unknown', emotion: 'neutral' }; }
export function presentationReducer(state, event) {
  if (event.type === 'activity') return { ...state, activity: ONLINE.has(state.connectionStatus) && ACTIVITIES.has(event.value) ? event.value : 'idle' };
  if (event.type === 'connection') {
    const status = typeof event.value === 'string' ? event.value : 'unknown';
    return { ...state, connectionStatus: status, activity: ONLINE.has(status) ? state.activity : 'idle' };
  }
  return state;
}
export function selectAction(manifest, state) {
  const candidate = Object.hasOwn(manifest.activityMap, state.activity) ? manifest.activityMap[state.activity] : undefined;
  return Object.hasOwn(manifest.actions, candidate) ? candidate : manifest.fallbackAction;
}
