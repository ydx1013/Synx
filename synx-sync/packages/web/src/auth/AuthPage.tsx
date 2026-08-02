import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { authApi } from '../api/queries';
import { useAuth } from './AuthProvider';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, authenticate } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (user) return <Navigate to="/notes" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    try {
      const result = mode === 'login'
        ? await authApi.login({ usernameOrEmail: fields.usernameOrEmail, password: fields.password })
        : await authApi.register({ username: fields.username, email: fields.email, password: fields.password });
      authenticate(result); navigate('/notes', { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请求失败'); }
    finally { setPending(false); }
  }

  const login = mode === 'login';
  return <main className="auth-page">
    <section className="auth-brand"><Link to="/" className="logo">Synx</Link><h1>你的笔记，存放在你自己的云端。</h1><p>直接浏览和编辑远程 Markdown，同时继续与 Obsidian 安全同步。</p></section>
    <section className="auth-panel"><form className="auth-form" onSubmit={submit}>
      <header><h2>{login ? '登录 Synx' : '创建账号'}</h2><p>{login ? '继续查看你的远程笔记' : '开始管理你的远程笔记'}</p></header>
      {!login && <><label>用户名<input name="username" minLength={3} autoComplete="username" required /></label><label>邮箱<input name="email" type="email" autoComplete="email" required /></label></>}
      {login && <label>用户名或邮箱<input name="usernameOrEmail" autoComplete="username" required autoFocus /></label>}
      <label>密码<input name="password" type="password" minLength={8} autoComplete={login ? 'current-password' : 'new-password'} required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={pending}>{pending ? '请稍候…' : login ? '登录' : '注册'}</button>
      <p className="auth-switch">{login ? '还没有账号？' : '已有账号？'} <Link to={login ? '/register' : '/login'}>{login ? '立即注册' : '返回登录'}</Link></p>
    </form></section>
  </main>;
}
