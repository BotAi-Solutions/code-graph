/**
 * The codebase intake feature: choosing a local project, sizing it up, indexing
 * it and reporting what came back.
 *
 * It ends where `features/code-graph` begins. This feature knows about folders,
 * runs and counts; it knows nothing about how a graph is drawn. The graph
 * feature knows nothing about where its graph came from. The only thing that
 * passes between them is a project id.
 */
export { ProjectSelector } from './components/ProjectSelector.js';
export type { ProjectSelectorProps } from './components/ProjectSelector.js';

export { IndexingProgress } from './components/IndexingProgress.js';
export { ProjectStats } from './components/ProjectStats.js';
export { ProjectDetails } from './components/ProjectDetails.js';
export { SelectedProject } from './components/SelectedProject.js';
export { LANGUAGE_LABELS, rankLanguages } from './model/languages.js';
export { DirectoryBrowser } from './components/DirectoryBrowser.js';

export { useProjectIntake } from './hooks/useProjectIntake.js';
export type { ProjectIntake, IntakeStatus, StartedProject } from './hooks/useProjectIntake.js';

export { selectProjectDirectory } from './services/project-directory.js';
export type { DirectorySelection } from './services/project-directory.js';
