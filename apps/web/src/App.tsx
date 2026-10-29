import { useState, useEffect } from 'react';
import {
  Routes,
  Route,
  NavLink,
  Link,
  Navigate,
  Outlet,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import {
  Aperture,
  Sun,
  Moon,
  Monitor,
  LayoutDashboard,
  Shuffle,
  FolderOpen,
  Settings,
  Trash2,
  LogOut,
  Menu,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';
import { api, json, setCsrf, useData, useAction } from './api';
import { Button, Field, Busy } from './components/ui';
import { Home, Gallery, Docs } from './Public';
import { Overview, Resources, Trash } from './Resources';
import { Services } from './Services';
import { SettingsPage } from './Settings';
import { Organization } from './Organization';
export function Brand() {
  const site = useData('public/settings');
  const title = site.data?.title ?? 'XHImg';
  useEffect(() => {
    document.title = `${title} · 一次整理，随处调用`;
  }, [title]);
  useEffect(() => {
    const changed = () => {
      void site.reload();
    };
    window.addEventListener('site-settings', changed);
    return () => window.removeEventListener('site-settings', changed);
  }, [site.reload]);
  return (
    <Link to="/" className="brand" aria-label={`${title} 首页`}>
      <span className="brand-icon">
        <Aperture size={23} />
      </span>
      {title}
      <span className="brand-dot">.</span>
    </Link>
  );
}
function Theme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'system');
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () =>
      (document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    update();
    media.addEventListener('change', update);
    localStorage.setItem('theme', theme);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  return (
    <button
      className="icon-button"
      aria-label={`主题：${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}`}
      title="切换浅色、深色与跟随系统"
      onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
    >
      {theme === 'system' ? (
        <Monitor size={18} />
      ) : theme === 'dark' ? (
        <Moon size={18} />
      ) : (
        <Sun size={18} />
      )}
    </button>
  );
}
function PublicShell() {
  const home = useLocation().pathname === '/';
  return (
    <div className={home ? 'public-site public-site-home' : 'public-site'}>
      <header className="public-header">
        <Brand />
        <nav aria-label="网站导航">
          <NavLink to="/" end>
            首页
          </NavLink>
          <NavLink to="/gallery">图库</NavLink>
          <NavLink to="/docs">API 文档</NavLink>
        </nav>
        <div className="header-actions">
          <Theme />
          <Link className="admin-link" to="/admin">
            管理入口 <ArrowUpRight size={15} />
          </Link>
        </div>
      </header>
      <Outlet />
      <footer className="public-footer">
        <Brand />
        <span>Organize Once. Serve Anywhere.</span>
        <span>让每一张图片，都有用武之地。</span>
      </footer>
    </div>
  );
}
function AdminShell() {
  const auth = useData('auth/me'),
    navigate = useNavigate(),
    [open, setOpen] = useState(false);
  useEffect(() => {
    if (auth.data) setCsrf(auth.data.csrf);
  }, [auth.data]);
  if (auth.loading) return <Busy />;
  if (auth.error) return <Navigate to="/login" replace />;
  return (
    <div className="admin-shell">
      <aside className={'sidebar ' + (open ? 'expanded' : '')}>
        <Brand />
        <p className="sidebar-caption">个人图片工作台</p>
        <nav aria-label="管理导航">
          {[
            ['/admin', LayoutDashboard, '概览'],
            ['/admin/services', Shuffle, '随机图服务'],
            ['/admin/folders', FolderOpen, '资源文件夹'],
            ['/admin/organize', Sparkles, '智能整理'],
            ['/admin/trash', Trash2, '回收站'],
            ['/admin/settings', Settings, '设置中心'],
          ].map(([path, Icon, label]: any) => (
            <NavLink key={path} to={path} end={path === '/admin'} onClick={() => setOpen(false)}>
              <Icon size={19} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{auth.data.username[0]?.toUpperCase()}</div>
          <div>
            <strong>{auth.data.username}</strong>
            <small>管理员</small>
          </div>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={async () => {
              await api('auth/logout', json('POST'));
              setCsrf('');
              navigate('/login');
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-header">
          <button
            className="icon-button menu-button"
            aria-label="展开管理导航"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Menu size={20} />
          </button>
          <span>你的图片，你的服务。</span>
          <div>
            <Link to="/" target="_blank">
              访问网站 <ArrowUpRight size={14} />
            </Link>
            <Theme />
          </div>
        </header>
        <main className="workspace">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
function AuthPage({ setup = false }: { setup?: boolean }) {
  const state = useData('setup'),
    navigate = useNavigate(),
    action = useAction(),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [token, setToken] = useState('');
  if (state.loading) return <Busy />;
  if (!setup && state.data && !state.data.installed) return <Navigate to="/setup" replace />;
  if (setup && state.data?.installed) return <Navigate to="/login" replace />;
  return (
    <div className="auth-page">
      <Brand />
      <section className="auth-card">
        <span className="large-mark">
          <Aperture size={36} />
        </span>
        <h1>{setup ? '从这里，开启你的图库。' : '欢迎回来。'}</h1>
        <p className="muted">
          {setup ? '创建唯一管理员，开始组织你的图片资源。' : '登录 XHImg，继续你的图片工作。'}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await action.run(
              async () => {
                if (setup) {
                  await api('setup', json('POST', { username, password, token }));
                  navigate('/login');
                } else {
                  const result = await api('auth/login', json('POST', { username, password }));
                  setCsrf(result.csrf);
                  navigate('/admin');
                }
              },
              setup ? '安装完成，请登录' : '',
            );
            if (ok) void state.reload();
          }}
        >
          {setup && (
            <Field label="一次性安装令牌" hint="在服务器启动日志中查看。">
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
          )}
          <Field label="管理员用户名">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              maxLength={120}
            />
          </Field>
          <Field label="密码" hint={setup ? '至少 12 个字符，请使用独立的安全密码。' : undefined}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={setup ? 12 : 1}
              maxLength={256}
              autoComplete={setup ? 'new-password' : 'current-password'}
            />
          </Field>
          <Button disabled={action.pending}>
            {action.pending ? '正在处理…' : setup ? '创建管理员' : '登录工作台'}
          </Button>
        </form>
      </section>
      <Link className="muted" to="/">
        返回公共网站
      </Link>
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route element={<PublicShell />}>
        <Route index element={<Home />} />
        <Route path="gallery" element={<Gallery />} />
        <Route path="docs" element={<Docs />} />
      </Route>
      <Route path="login" element={<AuthPage />} />
      <Route path="setup" element={<AuthPage setup />} />
      <Route path="admin" element={<AdminShell />}>
        <Route index element={<Overview />} />
        <Route path="services" element={<Services />} />
        <Route path="folders" element={<Resources />} />
        <Route path="organize" element={<Organization />} />
        <Route path="trash" element={<Trash />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route
        path="*"
        element={
          <main className="empty">
            <h1>页面不存在</h1>
            <Link to="/">返回首页</Link>
          </main>
        }
      />
    </Routes>
  );
}
