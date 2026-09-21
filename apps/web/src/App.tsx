import { AppLayout } from './layouts/AppLayout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ProjectGraphPage } from './pages/ProjectGraphPage.js';
import { RetrievalLabPage } from './pages/RetrievalLabPage.js';
import { useHashRoute } from './hooks/useHashRoute.js';

export function App(): React.JSX.Element {
  const route = useHashRoute();

  return (
    <AppLayout route={route}>
      {route.name === 'project' ? (
        <ProjectGraphPage projectId={route.projectId} />
      ) : route.name === 'retrieval' ? (
        <RetrievalLabPage projectId={route.projectId} />
      ) : (
        <DashboardPage />
      )}
    </AppLayout>
  );
}
