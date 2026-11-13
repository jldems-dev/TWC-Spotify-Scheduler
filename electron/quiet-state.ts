export type QuietPlaybackSnapshot = { wasPlaying: boolean; contextUri: string | null; trackUri: string | null; positionMs: number };

/** Keep only the playback details needed to resume after quiet hours. */
export function captureQuietPlayback(state: any): QuietPlaybackSnapshot {
  return {
    wasPlaying: state?.is_playing === true,
    contextUri: typeof state?.context?.uri === 'string' ? state.context.uri : null,
    trackUri: typeof state?.item?.uri === 'string' ? state.item.uri : null,
    positionMs: Number.isFinite(state?.progress_ms) ? Math.max(0, Math.floor(state.progress_ms)) : 0,
  };
}

export function quietRestorePlan(snapshot: QuietPlaybackSnapshot | null) {
  if (!snapshot || !snapshot.wasPlaying || !snapshot.contextUri) return null;
  return {
    context_uri: snapshot.contextUri,
    ...(snapshot.trackUri ? { offset: { uri: snapshot.trackUri } } : {}),
    positionMs: snapshot.positionMs,
  };
}
