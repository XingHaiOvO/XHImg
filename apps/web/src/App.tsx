import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
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
  Menu,
  ArrowUpRight,
  Sparkles,
  ChevronUp,
  X,
} from 'lucide-react';
import { api, json, setCsrf, useData, useAction } from './api';
import { ActionFeedback, Button, Field, Busy } from './components/ui';
import { Home, Gallery, Docs } from './Public';
import { Overview, Resources, Trash } from './Resources';
import { Services } from './Services';
import { SettingsPage } from './Settings';
import { Organization } from './Organization';
import { useSiteSettings } from './site-settings';
export function Brand() {
  const site = useSiteSettings();
  const title = site?.title ?? 'XHImg';
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [site?.logoUrl]);
  useEffect(() => {
    document.title = `${title} · 一次整理，随处调用`;
  }, [title]);
  return (
    <Link to="/" className="brand" aria-label={`${title} 首页`}>
      {site?.logoUrl && !logoFailed ? (
        <img className="brand-logo" src={site.logoUrl} alt="" onError={() => setLogoFailed(true)} />
      ) : (
        <span className="brand-icon">
          <Aperture size={23} />
        </span>
      )}
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
  const site = useSiteSettings();
  const title = site?.title ?? 'XHImg';
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
        <div className="footer-main">
          <Brand />
          <nav aria-label="页脚导航">
            <Link to="/gallery">图库</Link>
            <Link to="/docs">API 文档</Link>
            <Link to="/admin">
              管理入口 <ArrowUpRight size={14} />
            </Link>
          </nav>
        </div>
        <p className="footer-legal">
          © {new Date().getFullYear()} {title}
        </p>
      </footer>
    </div>
  );
}
function AdminShell() {
  const auth = useData('auth/me'),
    navigate = useNavigate(),
    location = useLocation(),
    [open, setOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const trashCount = useData('admin/images?trash=true&limit=1');
  const trashTotal = trashCount.data?.total ?? 0;
  const accountRows = useRef<{ desktop: HTMLDivElement | null; mobile: HTMLDivElement | null }>({
    desktop: null,
    mobile: null,
  });
  const logout = useAction();
  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    setMenuOpen(false);
  }, [open]);
  useEffect(() => {
    if (!menuOpen) return;
    const row = open ? accountRows.current.mobile : accountRows.current.desktop;
    if (!row) return;
    const closeMenu = () => {
      setMenuOpen(false);
      row.querySelector<HTMLButtonElement>('.account-button')?.focus();
    };
    row.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const pointerdown = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.contains(event.target)) {
        closeMenu();
        requestAnimationFrame(() => {
          if (row.isConnected && document.activeElement === document.body)
            row.querySelector<HTMLButtonElement>('.account-button')?.focus();
        });
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', pointerdown, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', pointerdown, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [menuOpen, open]);
  useEffect(() => {
    const media = matchMedia('(min-width: 651px)');
    const close = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  useEffect(() => {
    if (auth.data) setCsrf(auth.data.csrf);
  }, [auth.data]);
  useEffect(() => {
    const reloadCount = () => void trashCount.reload();
    window.addEventListener('trash-changed', reloadCount);
    return () => window.removeEventListener('trash-changed', reloadCount);
  }, [trashCount.reload]);
  if (auth.loading) return <Busy />;
  if (auth.error) return <Navigate to="/login" replace />;
  const navigation = (surface: 'desktop' | 'mobile') => (
    <>
      <Brand />
      <nav aria-label="管理导航">
        <div className="sidebar-group">
          {[
            ['/admin', LayoutDashboard, '概览'],
            ['/admin/services', Shuffle, '随机图服务'],
            ['/admin/folders', FolderOpen, '资源文件夹'],
            ['/admin/organize', Sparkles, '智能整理'],
            ['/admin/trash', Trash2, '回收站'],
          ].map(([path, Icon, label]: any) => (
            <NavLink key={path} to={path} end={path === '/admin'} onClick={() => setOpen(false)}>
              <Icon size={18} />
              {label}
              {path === '/admin/trash' && trashTotal > 0 && (
                <span className="nav-count">{trashTotal}</span>
              )}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-group sidebar-group-secondary">
          <NavLink to="/admin/settings" onClick={() => setOpen(false)}>
            <Settings size={18} />
            设置中心
          </NavLink>
        </div>
      </nav>
      <div
        className="sidebar-bottom"
        ref={(node) => {
          accountRows.current[surface] = node;
        }}
      >
        <button
          type="button"
          className="account-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen && (surface === 'mobile' ? open : !open)}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span className="avatar">{auth.data.username[0]?.toUpperCase()}</span>
          <span className="account-text">
            <strong>{auth.data.username}</strong>
            <small>管理员</small>
          </span>
          <ChevronUp size={14} className="account-chevron" aria-hidden="true" />
        </button>
        {menuOpen && (surface === 'mobile' ? open : !open) && (
          <div
            className="account-menu"
            role="menu"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = items.indexOf(document.activeElement as HTMLElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            <Link
              role="menuitem"
              to="/admin/settings?tab=security"
              onClick={() => setMenuOpen(false)}
            >
              修改密码
            </Link>
            <button
              type="button"
              role="menuitem"
              disabled={logout.pending}
              onClick={() => {
                void logout.run(async () => {
                  await api('auth/logout', json('POST'));
                  setCsrf('');
                  navigate('/login');
                }, '');
              }}
            >
              退出登录
            </button>
          </div>
        )}
      </div>
    </>
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className="admin-shell">
        <aside className="sidebar desktop-sidebar">{navigation('desktop')}</aside>
        <Dialog.Portal>
          <Dialog.Overlay className="navigation-overlay" />
          <Dialog.Content
            className="sidebar mobile-sidebar"
            onEscapeKeyDown={(event) => {
              if (menuOpen) {
                event.preventDefault();
                setMenuOpen(false);
                accountRows.current.mobile
                  ?.querySelector<HTMLButtonElement>('.account-button')
                  ?.focus();
              }
            }}
          >
            <Dialog.Title className="sr-only">管理导航</Dialog.Title>
            <Dialog.Description className="sr-only">
              选择工作区，按 Escape 关闭导航。
            </Dialog.Description>
            <Dialog.Close className="icon-button navigation-close" aria-label="关闭管理导航">
              <X size={20} />
            </Dialog.Close>
            {navigation('mobile')}
          </Dialog.Content>
        </Dialog.Portal>
        <div className="admin-main">
          <header className="admin-header">
            <Dialog.Trigger asChild>
              <button
                className="icon-button menu-button"
                aria-label="展开管理导航"
                aria-expanded={open}
              >
                <Menu size={20} />
              </button>
            </Dialog.Trigger>
            <div style={{ marginLeft: 'auto' }}>
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
    </Dialog.Root>
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
          <ActionFeedback action={action} />
        </form>
      </section>
      <Link className="muted" to="/">
        返回公共网站
      </Link>
    </div>
  );
}
export default function App() {
  const logoUrl = useSiteSettings()?.logoUrl;
  useEffect(() => {
    if (logoUrl === undefined) return;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    icon.href = logoUrl || '/favicon.svg';
    icon.onerror = () => {
      icon.onerror = null;
      icon.href = '/favicon.svg';
    };
    return () => {
      icon.onerror = null;
    };
  }, [logoUrl]);
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
