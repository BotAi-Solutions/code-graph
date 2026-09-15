import { AppLayout } from './layouts/AppLayout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ProjectGraphPage } from './pages/ProjectGraphPage.js';
import { useHashRoute } from './hooks/useHashRoute.js';

export function App(): React.JSX.Element {
  const route = useHashRoute();

  return (
    <AppLayout route={route}>
      {route.name === 'project' ? (
        <ProjectGraphPage projectId={route.projectId} />
      ) : (
        <DashboardPage />
      )}
    </AppLayout>
  );
}
