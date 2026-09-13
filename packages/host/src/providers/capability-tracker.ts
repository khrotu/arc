export class CapsTracker {
  private unsupported = new Map<string, { features: Set<string>; at: number }>();
  ttlMs = 30 * 60 * 1000;
  markUnsupported(modelKey: string, feature: string): void {
    let s = this.unsupported.get(modelKey);
    if (!s) { s = { features: new Set(), at: Date.now() }; this.unsupported.set(modelKey, s); }
    s.features.add(feature);
    s.at = Date.now();
  }
  isSupported(modelKey: string, feature: string): boolean {
    const s = this.unsupported.get(modelKey);
    if (!s) return true;
    if (Date.now() - s.at > this.ttlMs) {
      this.unsupported.delete(modelKey);
      return true;
    }
    return !s.features.has(feature);
  }
}
export const caps = new CapsTracker();