export class ReplayClock {
  private currentIso: string;

  constructor(initialIso = "1970-01-01T00:00:00.000Z") {
    this.currentIso = initialIso;
  }

  set(iso: string): void {
    this.currentIso = new Date(iso).toISOString();
  }

  now(): string {
    return this.currentIso;
  }
}
