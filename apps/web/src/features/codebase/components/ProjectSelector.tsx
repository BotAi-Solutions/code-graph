import { Spinner } from '../../../components/index.js';
import type { ProjectIntake } from '../hooks/useProjectIntake.js';
import { DirectoryBrowser } from './DirectoryBrowser.js';
import { SelectedProject } from './SelectedProject.js';

/**
 * The way into the product: choose a folder, see what is in it, index it.
 *
 * One action, prominent, and no filesystem path to type. The path is still
 * *shown* once a folder is chosen — it is how you confirm you picked the right
 * `api` out of the four on your machine — but it is never something to get
 * right by hand.
 */

export interface ProjectSelectorProps {
  intake: ProjectIntake;
  /** Rendered under the action; where the git-URL form lives. */
  footer?: React.ReactNode;
}

export function ProjectSelector({ intake, footer }: ProjectSelectorProps): React.JSX.Element {
  return (
    <div className="intake">
      {intake.directory ? (
        <SelectedProject intake={intake} />
      ) : (
        <div className="intake__hero">
          <h2 className="intake__title">Analyse your codebase</h2>
          <p className="intake__body">
            Choose a project on this machine and it will be scanned, parsed and turned into a code
            knowledge graph. Nothing is uploaded — the source is read locally and never leaves it.
          </p>

          <button
            type="button"
            className="button button--primary button--large"
            disabled={intake.busy}
            onClick={() => {
              void intake.choose();
            }}
          >
            <span aria-hidden="true">📁</span>
            {intake.status === 'choosing' ? 'Waiting for the folder dialog…' : 'Select project'}
          </button>

          {intake.status === 'choosing' && (
            <p className="intake__waiting">
              <Spinner label="Waiting for the folder dialog" />
              The folder dialog is open. It may be behind this window.
            </p>
          )}

          {intake.error && <p className="intake__error">{intake.error}</p>}

          {footer && <div className="intake__footer">{footer}</div>}
        </div>
      )}

      {intake.browserOpen && (
        <DirectoryBrowser
          reason={intake.browserReason}
          onClose={intake.closeBrowser}
          onSelect={(directory) => {
            void intake.accept(directory);
          }}
        />
      )}
    </div>
  );
}
