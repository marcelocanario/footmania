/** Groups are numbered (1-based): the pyramid grows exponentially, so letters run out. */
export function groupLabel(groupIndex: number): string {
  return String(groupIndex + 1);
}
