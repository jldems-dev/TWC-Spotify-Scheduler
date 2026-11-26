export type AudioKind = "announcement" | "advertisement";

export class RendererAudioActivity {
  private playing = new Map<AudioKind, { generation: number; resumeOnExit: boolean }>();

  start(kind: AudioKind, generation: number, resumeOnExit = false) {
    this.playing.set(kind, { generation, resumeOnExit });
  }

  finish(kind: AudioKind, generation: number) {
    if (this.playing.get(kind)?.generation === generation) this.playing.delete(kind);
  }

  clear() {
    const resume = [...this.playing.values()].some(activity => activity.resumeOnExit);
    this.playing.clear();
    return resume;
  }

  status(scheduled?: { active: string | null; windowActive: boolean }) {
    const announcement = !!scheduled?.active || this.playing.has("announcement");
    const advertisement = this.playing.has("advertisement");
    return { announcement, advertisement, blocked: announcement || advertisement || !!scheduled?.windowActive };
  }
}
