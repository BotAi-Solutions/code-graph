import { useEffect, useState } from 'react';

/**
 * Hash routing, in twenty lines.
 *
 * Two screens do not justify a router dependency, but they do justify real
 * URLs: a project's graph should survive a reload and be shareable with a
 * colleague. `#/` is the dashboard, `#/projects/<id>` the explorer.
 */
export type Route = { name: 'dashboard' } | { name: 'project'; projectId: string };

function parse(hash: string): Route {
  const match = /^#\/projects\/([^/?]+)/.exec(hash);
  if (match?.[1]) return { name: 'project', projectId: decodeURIComponent(match[1]) };
  return { name: 'dashboard' };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parse(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  return route;
}

export function navigate(route: Route): void {
  window.location.hash = route.name === 'project' ? `#/projects/${route.projectId}` : '#/';
}

export function hrefFor(route: Route): string {
  return route.name === 'project' ? `#/projects/${route.projectId}` : '#/';
}
