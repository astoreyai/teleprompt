import type { AppSnapshot, OverlaySnapshot } from '../../shared/contracts.js'

export function projectOverlaySnapshot(snapshot: AppSnapshot): OverlaySnapshot {
  const active = snapshot.documents.find((document) => document.id === snapshot.activeDocumentId)
  return {
    activeDocumentMeta: active
      ? { id: active.id, format: active.format, revision: active.revision }
      : null,
    scrollPosition: snapshot.scrollPosition,
    scrollSpeed: snapshot.scrollSpeed,
    playing: snapshot.playing,
    playbackSessionId: snapshot.playbackSessionId,
    bgDim: snapshot.bgDim,
    fontSize: snapshot.fontSize,
    fontFamily: snapshot.fontFamily,
    fontColor: snapshot.fontColor,
    textShadow: snapshot.textShadow,
    mirrorH: snapshot.mirrorH,
    mirrorV: snapshot.mirrorV,
    eyeLinePosition: snapshot.eyeLinePosition,
    showEyeLine: snapshot.showEyeLine,
    focusMode: snapshot.focusMode,
    markdown: snapshot.markdown,
    bannerMode: snapshot.bannerMode,
    bannerPosition: snapshot.bannerPosition,
    showChronometer: snapshot.showChronometer,
    countdownEnabled: snapshot.countdownEnabled,
    countdownSeconds: snapshot.countdownSeconds,
    showCueHud: snapshot.showCueHud,
  }
}
