import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { Admin } from './pages/Admin';
import { Agents } from './pages/Agents';
import { Approvals } from './pages/Approvals';
import { ExecutionLive } from './pages/ExecutionLive';
import { Executions } from './pages/Executions';
import { Home } from './pages/Home';
import { Integrations } from './pages/Integrations';
import { Login } from './pages/Login';
import { MfaRequired } from './pages/MfaRequired';
import { NewExecution } from './pages/NewExecution';
import { Projects } from './pages/Projects';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Login />;
  if (me.mfaEnrollmentRequired) return <MfaRequired />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="nova" element={<NewExecution />} />
        <Route path="execucoes" element={<Executions />} />
        <Route path="execucoes/:id" element={<ExecutionLive />} />
        <Route path="aprovacoes" element={<Approvals />} />
        <Route path="agentes" element={<Agents />} />
        <Route path="projetos" element={<Projects />} />
        <Route path="integracoes" element={<Integrations />} />
        <Route path="administracao" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
