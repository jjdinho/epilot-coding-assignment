// The game's rules in brief, shown above the alias form and in the "How to play" tooltip.
export function HowToPlay() {
  return (
    <ol className="list-decimal space-y-1 pl-5">
      <li>
        Press <strong>Up</strong> if you think the BTC/USD price will go up in the next minute, <strong>Down</strong>{' '}
        if you think it will go down.
      </li>
      <li>After 60 seconds, once the price has moved, you score +1 if you were right and −1 if not.</li>
      <li>You can have one guess open at a time.</li>
    </ol>
  );
}
