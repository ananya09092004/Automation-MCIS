import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ApiProvider } from './lib/apiContext.jsx';
import { WorkspaceProvider, useWorkspace } from './lib/workspace.jsx';
import { RouterProvider, useRouter, matchPath } from './lib/router.jsx';
import { ToastProvider } from './lib/toast.jsx';
import { ErrorState, Loading } from './components/ui.jsx';
import Shell from './components/Shell.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Agents from './pages/Agents.jsx';
import Tasks, { TaskDetail } from './pages/Tasks.jsx';
import Workflows from './pages/Workflows.jsx';
import Approvals from './pages/Approvals.jsx';
import Integrations from './pages/Integrations.jsx';
import Activity from './pages/Activity.jsx';
import Billing from './pages/Billing.jsx';
import Team from './pages/Team.jsx';
import Settings from './pages/Settings.jsx';
import SignIn from './pages/SignIn.jsx';
import NotFound from './pages/NotFound.jsx';

const ROUTES = [
  ['/', Dashboard], ['/agents', Agents], ['/tasks', Tasks], ['/tasks/:id', TaskDetail], ['/workflows', Workflows],
  ['/approvals', Approvals], ['/integrations', Integrations], ['/activity', Activity], ['/billing', Billing],
  ['/team', Team], ['/settings', Settings],
];

function Page() {
  const { path } = useRouter();
  const { workspaceId } = useWorkspace();
  for (const [pattern, Component] of ROUTES) {
    const params = matchPath(pattern, path);
    // key: remount on workspace change so no data from another workspace lingers.
    if (params) return <Component key={`${workspaceId}:${path}`} {...params} />;
  }
  return <NotFound />;
}

function Authenticated() {
  const ws = useWorkspace();
  if (ws.loading && !ws.workspaces.length) return <div className="center-screen"><Loading label="Loading your workspaces…" /></div>;
  if (ws.error) return <div className="center-screen"><ErrorState error={ws.error} onRetry={ws.reload} title="Could not load your workspaces" /></div>;
  if (!ws.current) return <div className="center-screen"><ErrorState error={{ message: 'You are not a member of any workspace.' }} title="No workspace" /></div>;
  return <Shell><Page /></Shell>;
}

function Gate() {
  const auth = useAuth();
  if (auth.status === 'loading') return <div className="center-screen"><Loading label="Checking your session…" /></div>;
  if (auth.status !== 'signedIn') return <SignIn />;
  return <WorkspaceProvider><Authenticated /></WorkspaceProvider>;
}

/** authClient: Firebase-backed in production (main.jsx), fake in tests. api: optional injected client (tests). */
export default function App({ authClient, api, initialPath }) {
  return (
    <AuthProvider client={authClient}>
      <ApiProvider api={api}>
        <RouterProvider initialPath={initialPath}>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </RouterProvider>
      </ApiProvider>
    </AuthProvider>
  );
}
