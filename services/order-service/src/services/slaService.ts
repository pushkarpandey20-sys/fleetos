export function computeSlaDeadline(slaMinutes: number): Date {
  const deadline = new Date();
  deadline.setMinutes(deadline.getMinutes() + slaMinutes);
  return deadline;
}

export function isSlaBreached(slaDeadline: Date | string): boolean {
  return new Date() > new Date(slaDeadline);
}

export function minutesToBreach(slaDeadline: Date | string): number {
  return Math.round((new Date(slaDeadline).getTime() - Date.now()) / 60000);
}
