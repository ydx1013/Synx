import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthPage } from './auth/AuthPage';
import { ProtectedRoute } from './components/ProtectedRoute';
import { NotesPage } from './notes/NotesPage';
import { SettingsLayout } from './settings/SettingsPage';

export function App() {
  return <Routes>
    <Route path="/" element={<HomeRedirect />} />
    <Route path="/login" element={<AuthPage mode="login" />} />
    <Route path="/register" element={<AuthPage mode="register" />} />
    <Route element={<ProtectedRoute />}>
      <Route path="/notes" element={<NotesPage />} />
      <Route path="/settings" element={<SettingsLayout />} />
      <Route path="/settings/storage" element={<SettingsLayout />} />
      <Route path="/settings/storage/new" element={<SettingsLayout />} />
      <Route path="/settings/storage/:storageId" element={<SettingsLayout />} />
    </Route>
    <Route path="/login.html" element={<Navigate to="/login" replace />} />
    <Route path="/register.html" element={<Navigate to="/register" replace />} />
    <Route path="/notes.html" element={<Navigate to="/notes" replace />} />
    <Route path="/dashboard.html" element={<Navigate to="/settings/storage" replace />} />
    <Route path="/storage_new.html" element={<Navigate to="/settings/storage/new" replace />} />
    <Route path="*" element={<Navigate to="/notes" replace />} />
  </Routes>;
}

function HomeRedirect() {
  return <Navigate to="/notes" replace />;
}
