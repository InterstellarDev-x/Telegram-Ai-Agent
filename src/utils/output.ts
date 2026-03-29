export function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}
