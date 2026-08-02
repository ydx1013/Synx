import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
    <Route path="*" element={<CatchAll />} />
  </Routes>;
}

function HomeRedirect() {
  return <Navigate to="/notes" replace />;
}

/** 从 URL 路径提取笔记相对路径。Obsidian 生成的分享链接形如 /肝窦毛细血管化.md
 *  （只有笔记名、无路径参数），据此转成 /notes?path=… 交给笔记页按文件名匹配打开。
 *  location.pathname 是编码形式（如 /%E8%82%9D…），需先解码得到真实路径。 */
export function notePathFromLocation(pathname: string): string | null {
  const notePath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!/\.(md|markdown)$/i.test(notePath)) return null;
  try { return decodeURIComponent(notePath); } catch { return notePath; }
}

function CatchAll() {
  const location = useLocation();
  const notePath = notePathFromLocation(location.pathname);
  // 对象形式 to + 已解码路径：避免对编码后的 pathname 二次编码导致 ?path= 双重编码
  if (notePath) return <Navigate to={{ pathname: '/notes', search: `?path=${encodeURIComponent(notePath)}` }} replace />;
  return <Navigate to="/notes" replace />;
}
