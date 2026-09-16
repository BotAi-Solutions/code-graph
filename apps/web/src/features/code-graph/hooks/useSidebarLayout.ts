import { useCallback, useRef, useState } from 'react';
import { useLocalStorage } from '../../../hooks/useLocalStorage.js';

/**
 * How much of the workspace the sidebar is allowed to take, and how the user
 * changes that.
 *
 * The graph is the workspace, so the sidebar is the thing that yields: it can
 * be dragged narrower, and collapsed to nothing. Both are remembered, because
 * how much room someone wants beside a graph is a property of their screen and
 * their work, not of this visit.
 *
 * Widths are in pixels rather than a percentage. A percentage looks tidy in a
 * stylesheet and is wrong in practice — the inspector needs roughly the same
 * number of characters whether the monitor is thirteen inches or thirty-two,
 * and a percentage gives it a third of an ultrawide.
 */

export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 340;

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
  /** True while a drag is in progress, so the canvas can suppress transitions. */
  resizing: boolean;
  toggle: () => void;
  expand: () => void;
  /** Attach to the drag handle's `onPointerDown`. */
  startResize: (event: React.PointerEvent<HTMLElement>) => void;
}

function clampWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

export function useSidebarLayout(): SidebarLayout {
  const [storedWidth, setStoredWidth] = useLocalStorage('ckg.workspace.sidebarWidth', null);
  const [storedCollapsed, setStoredCollapsed] = useLocalStorage(
    'ckg.workspace.sidebarCollapsed',
    null,
  );

  const parsed = storedWidth === null ? Number.NaN : Number.parseInt(storedWidth, 10);
  const [width, setWidth] = useState(() =>
    Number.isFinite(parsed) ? clampWidth(parsed) : SIDEBAR_DEFAULT_WIDTH,
  );
  const [collapsed, setCollapsed] = useState(storedCollapsed === 'true');
  const [resizing, setResizing] = useState(false);

  // The drag reads the pointer's distance from the right edge of the window,
  // which is the sidebar's own width — no element measurement, and it stays
  // correct if the window is resized mid-drag.
  const frame = useRef<number | null>(null);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      setResizing(true);

      const onMove = (move: PointerEvent): void => {
        // One update per frame: a pointermove can fire faster than the graph
        // can lay itself out, and the canvas resizes with the sidebar.
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setWidth(clampWidth(window.innerWidth - move.clientX));
        });
      };

      const onUp = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);

        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        setResizing(false);
        // Read from state at commit time rather than tracking a ref alongside
        // it: the final width is whatever the last frame settled on.
        setWidth((settled) => {
          setStoredWidth(String(settled));
          return settled;
        });
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [setStoredWidth],
  );

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      setStoredCollapsed(current ? 'false' : 'true');
      return !current;
    });
  }, [setStoredCollapsed]);

  const expand = useCallback(() => {
    setCollapsed((current) => {
      if (!current) return current;
      setStoredCollapsed('false');
      return false;
    });
  }, [setStoredCollapsed]);

  return { width, collapsed, resizing, toggle, expand, startResize };
}
