import { useCallback, useEffect, useRef, useState } from 'react';
import { inspectProject } from '../../../api/filesystem.api.js';
import {
  attachRepository,
  createProject,
  startAnalysis,
} from '../../../api/projects.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { ProjectMetadata, SelectedDirectory } from '../../../types/index.js';
import {
  selectProjectDirectory,
  type DirectorySelection,
} from '../services/project-directory.js';

/**
 * The select → inspect → index flow, as one piece of state.
 *
 *   idle ──choose──▶ choosing ──▶ inspecting ──▶ ready ──index──▶ starting ──▶ started
 *                        │                │
 *                        └── cancelled ───┴──▶ back to where it was
 *
 * The flow lives in a hook rather than in the components because it is a
 * sequence, and a sequence spread across three components is one someone has to
 * reconstruct by reading all three. The components below are then only shapes:
 * given this state, draw this.
 *
 * Nothing here talks to the filesystem, and nothing here knows how the graph is
 * drawn. It moves between two API calls and reports where it is.
 */

export type IntakeStatus =
  | 'idle'
  | 'choosing'
  | 'inspecting'
  | 'ready'
  | 'starting'
  | 'started';

export interface ProjectIntakeState {
  status: IntakeStatus;
  directory: SelectedDirectory | null;
  metadata: ProjectMetadata | null;
  error: string | null;
  /** Set when the host has no native dialog: the browser is the way in. */
  browserOpen: boolean;
  /** Why the native dialog is unavailable, for the browser's own explanation. */
  browserReason: string | null;
}

export interface StartedProject {
  projectId: string;
  name: string;
}

export interface ProjectIntake extends ProjectIntakeState {
  /** Opens the native dialog, falling back to the in-app browser. */
  choose: () => Promise<void>;
  /** Accepts a directory the in-app browser produced. */
  accept: (directory: SelectedDirectory) => Promise<void>;
  closeBrowser: () => void;
  /** Creates the project, attaches the folder and queues the first run. */
  index: () => Promise<void>;
  busy: boolean;
}

const INITIAL: ProjectIntakeState = {
  status: 'idle',
  directory: null,
  metadata: null,
  error: null,
  browserOpen: false,
  browserReason: null,
};

export function useProjectIntake(onStarted: (project: StartedProject) => void): ProjectIntake {
  const [state, setState] = useState<ProjectIntakeState>(INITIAL);

  // The flow outlives individual renders — a native dialog can sit open for a
  // minute — so a result that arrives after the component is gone is dropped
  // rather than setting state on nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const update = useCallback((patch: Partial<ProjectIntakeState>) => {
    if (!mounted.current) return;
    setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const inspect = useCallback(
    async (directory: SelectedDirectory) => {
      update({
        status: 'inspecting',
        directory,
        metadata: null,
        error: null,
        browserOpen: false,
      });

      try {
        const metadata = await inspectProject(directory.path);
        update({ status: 'ready', metadata });
      } catch (error) {
        // The folder is still shown: knowing *which* folder has no source in it
        // is the useful half of the message.
        update({ status: 'ready', metadata: null, error: errorMessage(error) });
      }
    },
    [update],
  );

  const choose = useCallback(async () => {
    update({ status: 'choosing', error: null });

    let selection: DirectorySelection;
    try {
      selection = await selectProjectDirectory();
    } catch (error) {
      update({ status: state.directory ? 'ready' : 'idle', error: errorMessage(error) });
      return;
    }

    if (selection.outcome === 'cancelled') {
      update({ status: state.directory ? 'ready' : 'idle' });
      return;
    }

    if (selection.outcome === 'unavailable') {
      update({
        status: state.directory ? 'ready' : 'idle',
        browserOpen: true,
        browserReason: selection.reason,
      });
      return;
    }

    await inspect(selection.directory);
  }, [inspect, state.directory, update]);

  const index = useCallback(async () => {
    const directory = state.directory;
    if (!directory) return;

    update({ status: 'starting', error: null });

    try {
      // Three calls because they are three facts: the project exists, this
      // folder is its source, and a run has been asked for. The API keeps them
      // separate so a project can be re-pointed or re-run without recreating it.
      const project = await createProject({ name: directory.name });
      await attachRepository(project.id, { sourceType: 'local', sourcePath: directory.path });
      await startAnalysis(project.id);

      update({ status: 'started' });
      onStartedRef.current({ projectId: project.id, name: project.name });
    } catch (error) {
      update({ status: 'ready', error: errorMessage(error) });
    }
  }, [state.directory, update]);

  return {
    ...state,
    choose,
    accept: inspect,
    closeBrowser: () => {
      update({ browserOpen: false });
    },
    index,
    busy: state.status === 'choosing' || state.status === 'inspecting' || state.status === 'starting',
  };
}
