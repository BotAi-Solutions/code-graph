import { api } from './client.js';
import type { AnalysisJob, Project, ProjectSummary, Repository } from '../types/index.js';

/** The dashboard listing: each project with its graph size and last run. */
export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const { data } = await api.get<ProjectSummary[]>('/api/projects?limit=100', signal);
  return data;
}

export async function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
  const { data } = await api.get<Project>(`/api/projects/${projectId}`, signal);
  return data;
}

export async function createProject(input: {
  name: string;
  description?: string;
}): Promise<Project> {
  const { data } = await api.post<Project>('/api/projects', input);
  return data;
}

/**
 * Removes a project and its whole graph. The analysed source on disk is not
 * touched — this deletes what we derived from it.
 */
export async function deleteProject(projectId: string): Promise<void> {
  await api.delete<null>(`/api/projects/${projectId}`);
}

export async function attachRepository(
  projectId: string,
  input: { sourceType: 'local' | 'git'; sourcePath: string },
): Promise<Repository> {
  const { data } = await api.post<Repository>(`/api/projects/${projectId}/repository`, input);
  return data;
}

export async function getRepository(
  projectId: string,
  signal?: AbortSignal,
): Promise<Repository> {
  const { data } = await api.get<Repository>(`/api/projects/${projectId}/repository`, signal);
  return data;
}

export async function startAnalysis(projectId: string): Promise<AnalysisJob> {
  const { data } = await api.post<AnalysisJob>(`/api/projects/${projectId}/analysis`, {});
  return data;
}

export async function getAnalysis(
  projectId: string,
  analysisId: string,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  const { data } = await api.get<AnalysisJob>(
    `/api/projects/${projectId}/analysis/${analysisId}`,
    signal,
  );
  return data;
}

export async function listAnalyses(
  projectId: string,
  signal?: AbortSignal,
): Promise<AnalysisJob[]> {
  const { data } = await api.get<AnalysisJob[]>(`/api/projects/${projectId}/analysis`, signal);
  return data;
}
