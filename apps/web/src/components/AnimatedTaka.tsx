import { useEffect, useRef, useState } from 'react';
import { COUNT_UP_MS, paisaAt } from '../lib/countUp';
import { taka } from '../lib/money';
import { isPrivate } from '../lib/privacy';
import { onSplashGone } from '../lib/splash';

/** No counting in privacy mode (the real digits never reach the page) or when the phone asks for less motion. */
const canAnimate = (): boolean => !isPrivate() && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let landed = false;

/** True on the first visit to the page since the app opened or reloaded; coming back to it later is false. */
export function useFirstVisit(): boolean {
  const [first] = useState(() => !landed);
  useEffect(
    () => () => {
      landed = true;
    },
    [],
  );
  return first;
}

/**
 * A taka amount like `taka()`, that counts up from zero when `intro` is set (once the launch splash
 * has gone) and rolls from the old amount to the new one when it changes, for example after a pull
 * to refresh. Screen readers get only the final amount.
 */
export function AnimatedTaka({ paisa, intro }: { paisa: string | bigint; intro: boolean }) {
  const target = BigInt(paisa);
  const [shown, setShown] = useState(() => (intro && canAnimate() ? 0n : target));
  const current = useRef(shown);

  useEffect(() => {
    const show = (v: bigint) => {
      current.current = v;
      setShown(v);
    };
    const from = current.current;
    if (from === target || !canAnimate()) {
      show(target);
      return;
    }
    let frame = 0;
    const stop = onSplashGone(() => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / COUNT_UP_MS);
        show(paisaAt(from, target, t));
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [target]);

  return (
    <span className="tabular-nums">
      <span aria-hidden="true">{taka(shown)}</span>
      <span className="sr-only">{taka(target)}</span>
    </span>
  );
}
