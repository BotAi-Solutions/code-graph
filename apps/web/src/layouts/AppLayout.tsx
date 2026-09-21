import { navigate, type Route } from '../hooks/useHashRoute.js';

/**
 * In development the dev server proxies `/docs` to the API. A production build
 * is served on its own origin, so it needs the API's URL, which the deployer
 * supplies as `VITE_API_BASE_URL`.
 */
const DOCS_URL = `${import.meta.env.VITE_API_BASE_URL ?? ''}/docs`;

export interface AppLayoutProps {
  route: Route;
  children: React.ReactNode;
}

/**
 * The dashboard is a document: it scrolls, and it is easier to read held to a
 * comfortable measure. The project page is an application: it fills the window,
 * uses every pixel of width the screen has, and scrolls inside its own panels
 * rather than as a page. One class is the whole difference.
 */
function shellVariant(route: Route): string {
  return route.name === 'project' || route.name === 'retrieval' ? ' app--workspace' : '';
}

export function AppLayout({ route, children }: AppLayoutProps): React.JSX.Element {
  return (
    <div className={`app${shellVariant(route)}`}>
      <header className="app__header">
        <a
          className="app__brand"
          href="#/"
          onClick={(event) => {
            event.preventDefault();
            navigate({ name: 'dashboard' });
          }}
        >
          <span className="app__logo" aria-hidden="true" />
          <span className="app__wordmark">
            <span className="app__title">Code Knowledge Graph</span>
            <span className="app__subtitle">SCIP-derived structure for any repository</span>
          </span>
        </a>

        <nav className="app__nav" aria-label="Sections">
          <a
            className={`app__nav-link${route.name === 'dashboard' ? ' app__nav-link--active' : ''}`}
            href="#/"
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: 'dashboard' });
            }}
          >
            Dashboard
          </a>
          <a
            className={`app__nav-link${route.name === 'retrieval' ? ' app__nav-link--active' : ''}`}
            href="#/retrieval"
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: 'retrieval', projectId: null });
            }}
          >
            Retrieval Lab
          </a>
          <a
            className="app__nav-link"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            API docs
          </a>
        </nav>
      </header>

      <main className="app__main">{children}</main>
    </div>
  );
}
