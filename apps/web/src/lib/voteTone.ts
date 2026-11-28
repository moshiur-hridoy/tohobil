/**
 * A vote button's colours, the same on the list and the vote page. All three look alike until one is
 * chosen, so colour does not lean a member towards "yes"; the chosen one fills with what it means:
 * green for yes (voting is the screen's main action), red for no, grey for abstain.
 */
export function choiceTone(choice: 'yes' | 'no' | 'abstain', active: boolean): string {
  if (!active) return 'border-[1.5px] border-input bg-card text-foreground';
  if (choice === 'yes') return 'bg-primary text-primary-foreground';
  return choice === 'no' ? 'bg-bad text-primary-foreground' : 'bg-muted text-primary-foreground';
}
