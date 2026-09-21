import { useEffect, useState } from 'react';

/**
 * Hash routing, in twenty lines.
 *
 * Two screens do not justify a router dependency, but they do justify real
 * URLs: a project's graph should survive a reload and be shareable with a
 * colleague. `#/` is the dashboard, `#/projects/<id>` the explorer, and
 * `#/retrieval/<id>` the retrieval lab pointed at one project.
 */
export type Route =
  | { name: 'dashboard' }
  | { name: 'project'; projectId: string }
  | { name: 'retrieval'; projectId: string | null };

function parse(hash: string): Route {
  const match = /^#\/projects\/([^/?]+)/.exec(hash);
  if (match?.[1]) return { name: 'project', projectId: decodeURIComponent(match[1]) };
  const lab = /^#\/retrieval(?:\/([^/?]+))?/.exec(hash);
  if (lab) return { name: 'retrieval', projectId: lab[1] ? decodeURIComponent(lab[1]) : null };
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
  window.location.hash = hrefFor(route);
}

export function hrefFor(route: Route): string {
  if (route.name === 'project') return `#/projects/${route.projectId}`;
  if (route.name === 'retrieval') {
    return route.projectId === null ? '#/retrieval' : `#/retrieval/${route.projectId}`;
  }
  return '#/';
}
