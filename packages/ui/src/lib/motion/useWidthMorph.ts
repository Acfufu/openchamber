import React from 'react';

const readMotionVariable = (name: string): string => (
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()
);

const prefersReducedMotion = (): boolean => (
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
);

/** Starts easing `element` into its new width on every change of its content; returns the cleanup. */
const watchWidth = (element: HTMLElement): (() => void) => {
  if (typeof MutationObserver === 'undefined' || !('animate' in element)) return () => undefined;
  let settledWidth = element.getBoundingClientRect().width;
  let running: Animation | null = null;

  const onContentChange = () => {
    const moving = running?.playState === 'running';
    const from = moving ? element.getBoundingClientRect().width : settledWidth;
    running?.cancel();
    running = null;
    const to = element.getBoundingClientRect().width;
    settledWidth = to;
    // Nothing to show while hidden (zero width), when nothing moved, or for
    // readers who asked for less motion.
    if (from <= 0 || Math.abs(from - to) < 1 || prefersReducedMotion()) return;
    const duration = Number.parseFloat(readMotionVariable('--oc-motion-layout-duration')) || 0;
    if (duration <= 0) return;
    const animation = element.animate(
      [{ width: `${from}px` }, { width: `${to}px` }],
      { duration, easing: readMotionVariable('--oc-motion-layout-easing') || 'ease-out' },
    );
    running = animation;
    // While it grows, a truncating label would flash its ellipsis: the move
    // clips the text instead (design-system.css), until it settles.
    element.setAttribute('data-width-morphing', '');
    const settle = () => {
      if (running === animation || running === null) element.removeAttribute('data-width-morphing');
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', settle);
  };

  const observer = new MutationObserver(onContentChange);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    running?.cancel();
    element.removeAttribute('data-width-morphing');
  };
};

/**
 * Eases an element into its new width whenever its content changes, on the
 * layout spring: a picker that now names a longer model grows into it instead
 * of shoving its neighbours over in one frame. It watches the content rather
 * than a key, because a change can arrive in parts (the new name first, the
 * provider's logo a moment later); each part retargets the move from where
 * the element stands now, so it never ends short and jumps the rest. The
 * element keeps its natural width; the animation only covers the move. Width
 * is a layout property, so this runs once per change on a small inline
 * control, never on a loop.
 */
export const useWidthMorph = (ref: React.RefObject<HTMLElement | null>): void => {
  // The element can mount after the hook's owner (a picker shown only for
  // some models), so each commit checks which element the ref holds now.
  const attachedRef = React.useRef<{ element: HTMLElement; detach: () => void } | null>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (attachedRef.current?.element === element) return;
    attachedRef.current?.detach();
    attachedRef.current = element ? { element, detach: watchWidth(element) } : null;
  });
  React.useEffect(() => () => {
    attachedRef.current?.detach();
    attachedRef.current = null;
  }, []);
};
