'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, ArrowUpRight, Box, Check, ChevronRight, CircleHelp, HardDrive, Layers, Network, Package, Pause, Play, Plus, RefreshCw, Search, Server, Square, Trash2, Zap } from 'lucide-react';
import { ComposeEditor } from '@/components/compose-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { validateCompose } from '@/lib/validate-compose';
import { ApiError, api, formatBytes, post, type ComposeProject, type Container, type ImageRecord, type SystemInfo } from '@/lib/api';

type Page = '容器管理' | '镜像管理' | 'Compose 项目' | '加速源配置';
type MirrorSource = { id: string; url: string; enabled: boolean; active?: boolean };
type MirrorState = {
  sources: MirrorSource[];
  active: string[];
  canApply: boolean;
  hostConfigPath: string;
};
type Modal =
  | { kind: 'upgrade' | 'restart'; container: Container }
  | { kind: 'compose' }
  | { kind: 'view'; project: ComposeProject }
  | { kind: 'help' }
  | null;

const navigation: Array<{ label: Page; icon: typeof Box }> = [
  { label: '容器管理', icon: Box }, { label: '镜像管理', icon: HardDrive },
  { label: 'Compose 项目', icon: Layers }, { label: '加速源配置', icon: Zap },
];
const defaultCompose = `services:
  nginx:
    image: nginx:latest
    ports:
      - "8080:80"
    restart: unless-stopped`;
const colors = ['green', 'blue', 'red', 'purple', 'cyan'];

export default function Home() {
  const [page, setPage] = useState<Page>('容器管理');
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [project, setProject] = useState('');
  const [directory, setDirectory] = useState('');
  const [compose, setCompose] = useState(defaultCompose);
  const [fileChoice, setFileChoice] = useState<'overwrite' | 'reference' | null>(null);
  const [existing, setExisting] = useState<{ exists: boolean; content: string | null } | null>(null);
  const [checkingFile, setCheckingFile] = useState(false);
  const [mirrorSources, setMirrorSources] = useState<MirrorSource[]>([]);
  const [newMirror, setNewMirror] = useState('');
  const [activeMirrors, setActiveMirrors] = useState<string[]>([]);
  const [mirrorCanApply, setMirrorCanApply] = useState(false);

  const composeIssues = useMemo(() => validateCompose(compose), [compose]);
  const relativeDirectory = directory.trim();
  const directoryValid = relativeDirectory.length > 0 && relativeDirectory.split('/').every((part) => /^[a-zA-Z0-9_\-\u4e00-\u9fff][a-zA-Z0-9_.\-\u4e00-\u9fff]*$/.test(part));
  const projectValid = /^[a-z0-9][a-z0-9_-]*$/.test(project.trim());
  const filePath = directoryValid ? `/composeFile/${relativeDirectory}/docker-compose.yml` : '';

  const showError = useCallback((error: unknown) => setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) }), []);
  const refresh = useCallback(async () => {
    const [a, b, c, d] = await Promise.all([
      api<{ containers: Container[] }>('/api/containers'), api<{ images: ImageRecord[] }>('/api/images'),
      api<{ projects: ComposeProject[] }>('/api/compose/projects'), api<SystemInfo>('/api/system'),
    ]);
    setContainers(a.containers); setImages(b.images); setProjects(c.projects); setSystem(d);
  }, []);
  const loadMirrors = useCallback(async () => {
    const result = await api<MirrorState>('/api/docker/mirrors');
    setMirrorSources(result.sources); setActiveMirrors(result.active); setMirrorCanApply(result.canApply);
  }, []);
  const checkUpdates = useCallback(async (force = false) => {
    setChecking(true);
    try {
      await post('/api/updates/check', { force });
      const deadline = Date.now() + 10 * 60_000;
      while (true) {
        const scan = await api<{ running: boolean }>('/api/updates');
        if (!scan.running) break;
        if (Date.now() >= deadline) throw new Error('镜像检查仍在后台运行，请稍后刷新页面查看结果');
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      await refresh();
      if (force) setNotice({ type: 'ok', text: 'latest 镜像检查完成' });
    }
    catch (error) { showError(error); } finally { setChecking(false); }
  }, [refresh, showError]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api<{ authenticated: boolean }>('/api/auth/session');
        if (!active) return;
        setAuthenticated(session.authenticated);
        if (!session.authenticated) return;
        await refresh();
        if (active) void checkUpdates(false);
      } catch (error) {
        if (active) showError(error);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [checkUpdates, refresh, showError]);
  useEffect(() => {
    if (page !== '加速源配置') return;
    const timer = window.setTimeout(() => void loadMirrors().catch(showError), 0);
    return () => window.clearTimeout(timer);
  }, [loadMirrors, page, showError]);
  useEffect(() => {
    if (modal?.kind !== 'compose' || !directoryValid) {
      const reset = window.setTimeout(() => setExisting(null), 0);
      return () => window.clearTimeout(reset);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCheckingFile(true);
      try { setExisting(await api(`/api/compose/file?directory=${encodeURIComponent(relativeDirectory)}`, { signal: controller.signal })); setFileChoice(null); }
      catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) showError(error); }
      finally { setCheckingFile(false); }
    }, 350);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [directoryValid, modal?.kind, relativeDirectory, showError]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), notice.type === 'error' ? 7000 : 4000); return () => window.clearTimeout(timer); }, [notice]);

  const updates = containers.filter((item) => item.update?.available);
  const updateErrors = images.filter((item) => item.update?.status === 'error');
  const running = containers.filter((item) => item.state === 'running').length;
  const visible = containers.filter((item) => (filter === '全部' || stateText(item.state) === filter) && `${item.name} ${item.image} ${item.project || ''}`.toLowerCase().includes(query.toLowerCase()));

  function startCompose() { setProject(''); setDirectory(''); setCompose(defaultCompose); setExisting(null); setFileChoice(null); setModal({ kind: 'compose' }); }
  async function openProject(item: ComposeProject) {
    setBusy(`view:${item.name}`);
    try { const file = await api<{ content: string | null }>(`/api/compose/file?directory=${encodeURIComponent(item.directory)}`); setProject(item.name); setDirectory(item.directory); setCompose(file.content || ''); setModal({ kind: 'view', project: item }); }
    catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function deploy() {
    if (!projectValid || !directoryValid || composeIssues.length || checkingFile) return;
    if (existing?.exists && !fileChoice) { setNotice({ type: 'error', text: '请选择覆盖已有文件或引用已有内容' }); return; }
    setBusy('compose:deploy');
    try {
      await post('/api/compose/deploy', { project: project.trim(), directory: relativeDirectory, content: compose, mode: existing?.exists ? fileChoice : 'create' });
      setNotice({ type: 'ok', text: `${project} 已部署` }); setModal(null); await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FILE_EXISTS') setExisting({ exists: true, content: (error.details as { content?: string } | undefined)?.content || '' });
      showError(error);
    } finally { setBusy(null); }
  }
  async function containerAction(item: Container, action: string) {
    setBusy(`container:${item.id}`);
    try { await post(`/api/containers/${item.id}/${action}`); setNotice({ type: 'ok', text: `${item.name} 操作完成` }); setModal(null); await refresh(); }
    catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function projectAction(item: ComposeProject, action: string) {
    setBusy(`project:${item.name}`);
    try { await post(`/api/compose/${item.name}/${action}`); setNotice({ type: 'ok', text: `${item.name} 操作完成` }); await refresh(); }
    catch (error) { showError(error); } finally { setBusy(null); }
  }
  function addMirror() {
    const value = newMirror.trim();
    if (!value) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      const normalized = url.toString().replace(/\/$/, '');
      if (mirrorSources.some((source) => source.url === normalized)) {
        setNotice({ type: 'error', text: '这个镜像源已经存在' });
        return;
      }
      setMirrorSources((sources) => [...sources, { id: `mirror-${Date.now()}`, url: normalized, enabled: false }]);
      setNewMirror('');
    } catch {
      setNotice({ type: 'error', text: '请输入有效的 HTTP 或 HTTPS 镜像源地址' });
    }
  }
  async function applyMirrorConfig() {
    setBusy('mirrors');
    try {
      const result = await post<MirrorState>('/api/docker/mirrors/apply', { sources: mirrorSources });
      setMirrorSources(result.sources); setActiveMirrors(result.active);
      setNotice({ type: 'ok', text: '镜像源配置已写入宿主机并热重载生效' });
    }
    catch (error) { showError(error); } finally { setBusy(null); }
  }

  async function login(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true); setLoginError('');
    try {
      await post('/api/auth/login', { username: loginUsername, password: loginPassword });
      setAuthenticated(true); setLoading(true); setLoginPassword('');
      await refresh(); void checkUpdates(false);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    } finally { setLoading(false); setLoginBusy(false); }
  }

  async function logout() {
    await post('/api/auth/logout').catch(() => undefined);
    setAuthenticated(false); setSystem(null); setContainers([]); setImages([]); setProjects([]);
  }

  if (authenticated === null) return <div className="login-screen"><div className="login-loading"><RefreshCw className="spin" />正在连接 DockerManager…</div></div>;
  if (!authenticated) return <div className="login-screen"><form className="login-card" onSubmit={(event) => void login(event)}><span className="brand-icon"><Box size={26} /></span><div><h1>登录 DockerManager</h1><p>连接宿主机 Docker 管理台</p></div><label htmlFor="login-username">用户名</label><Input id="login-username" autoComplete="username" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} /><label htmlFor="login-password">密码</label><Input id="login-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} />{loginError && <p className="field-error" role="alert">{loginError}</p>}<Button type="submit" disabled={loginBusy || !loginUsername || !loginPassword}>{loginBusy ? '正在登录…' : '登录'}</Button></form></div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="DockerManager 首页"><span className="brand-icon"><Box size={24} /></span><span>Docker<span className="brand-light">Manager</span><small>HOST CONTROL CENTER</small></span></Link>
      <div className="workspace"><span className="host-icon"><Server size={18} /></span><div><b>{system?.name || 'Docker 主机'}</b><small>{system?.operatingSystem || '正在连接…'}</small></div><span className={system ? 'online-dot' : 'offline-dot'} /></div>
      <p className="nav-label">工作空间</p><nav>{navigation.map((item) => <button key={item.label} className={`nav-item ${page === item.label ? 'active' : ''}`} onClick={() => { setPage(item.label); setQuery(''); }}><item.icon size={19} /><span>{item.label}</span>{item.label === '容器管理' && <span className="nav-count">{containers.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection"><span className={system ? 'online-dot' : 'offline-dot'} />{system ? 'Docker 引擎已连接' : 'Docker 引擎未连接'}<small>{system ? `v${system.serverVersion} · ${system.architecture}` : '检查 Socket 挂载'}</small></div><button className="help" onClick={() => setModal({ kind: 'help' })}><CircleHelp size={17} />使用说明<ArrowUpRight size={15} /></button><button className="profile" onClick={() => void logout()} title="退出登录"><span className="avatar">A</span><div><b>Administrator</b><small>点击退出登录</small></div></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div>工作空间 <ChevronRight size={14} /> <span>{page}</span></div><div><span className="top-host"><span className={system ? 'online-dot' : 'offline-dot'} />{system?.name || '未连接'}</span></div></header>
      <main><h1 className="sr-only">{page}</h1>{page === 'Compose 项目' && <div className="compose-page-actions"><Button onClick={startCompose}><Plus />部署 Compose</Button></div>}
        {page === '容器管理' && <><section className="metrics"><Metric icon={<Box />} label="全部容器" value={containers.length} detail="当前宿主机" /><Metric icon={<Activity />} label="运行中" value={running} detail="服务运行正常" green /><Metric icon={<Pause />} label="暂停 / 停止" value={containers.length - running} detail="可随时恢复" /><Metric icon={<Package />} label="可升级镜像" value={checking ? '—' : updates.length} detail="仅检查 latest" blue /></section>
          <section className="updates-panel"><div className="section-line"><div className="section-title"><span className="update-symbol"><ArrowUpRight size={20} /></span><h2>{checking ? '正在拉取 latest 镜像' : updates.length ? '发现可升级镜像' : updateErrors.length ? `${updateErrors.length} 个镜像检查失败` : 'latest 镜像均为最新'}</h2><span className="count-badge">{checking ? '…' : updates.length}</span></div><button className="text-button" disabled={checking} onClick={() => void checkUpdates(true)}><RefreshCw size={14} className={checking ? 'spin' : ''} />{checking ? '检查中' : '重新检查'}</button></div><p className="section-description">检查会拉取 latest 镜像到宿主机，但不会重建正在运行的容器。</p><div className="update-cards">{updates.map((item, index) => <article className="update-card" key={item.id}><AppIcon name={item.name} color={colors[index % colors.length]} /><div className="update-info"><b>{imageName(item.image)}<span className="tag">latest</span></b><small>关联容器：{item.name}</small></div><button className="update-action" onClick={() => setModal({ kind: 'upgrade', container: item })}>升级<ArrowUpRight size={14} /></button></article>)}{!checking && !updates.length && !updateErrors.length && <p className="success-inline"><Check size={17} />当前容器使用的 latest 镜像均为最新</p>}{!checking && !!updateErrors.length && <p className="error-text">部分镜像检查失败，请在“镜像管理”中查看原因。</p>}</div><div className="update-foot"><span><span className="online-dot" />进入页面自动检查</span><span>固定版本标签不参与检查</span></div></section>
          <section className="container-panel"><div className="list-heading"><div className="section-title"><h2>容器列表</h2><span className="muted">{containers.length} 个容器</span></div><div className="search"><Search size={16} /><Input aria-label="搜索容器" placeholder="搜索容器、镜像或项目…" value={query} onChange={(event) => setQuery(event.target.value)} /></div></div><div className="filter-line"><div className="filters">{['全部', '运行中', '已暂停', '已停止'].map((state) => <button key={state} onClick={() => setFilter(state)} className={filter === state ? 'selected' : ''}>{state}<span>{state === '全部' ? containers.length : containers.filter((item) => stateText(item.state) === state).length}</span></button>)}</div><span className="port-legend"><Network size={14} />宿主机端口 <ArrowRight size={13} /> 容器端口</span></div><ContainerTable items={visible} busy={busy} loading={loading} action={containerAction} restart={(item) => setModal({ kind: 'restart', container: item })} /><div className="table-footer">显示 {visible.length} / {containers.length} 个容器<span><span className={system ? 'online-dot' : 'offline-dot'} />宿主机实时状态</span></div></section></>}
        {page === '镜像管理' && <section className="container-panel"><div className="list-heading"><h2>本地镜像 <span className="muted">{images.length}</span></h2><Button variant="outline" disabled={checking} onClick={() => void checkUpdates(true)}><RefreshCw className={checking ? 'spin' : ''} />{checking ? '检查中' : '检查 latest 更新'}</Button></div><div className="image-list">{images.map((item, index) => <div className="image-row" key={`${item.id}-${item.tag}`}><AppIcon name={item.tag} color={colors[index % colors.length]} /><div className="grow"><b>{item.tag}</b><small>{item.containers.length ? `使用容器：${item.containers.join('、')}` : '未被容器使用'} · {formatBytes(item.size)}</small></div><span className={item.update?.status === 'error' ? 'error-text' : 'muted'}>{!isLatest(item.tag) ? '固定版本' : item.update?.status === 'checking' ? '检查中' : item.update?.available ? '有更新可用' : item.update?.status === 'error' ? item.update.error : checking ? '等待检查' : '已是最新'}</span></div>)}</div></section>}
        {page === 'Compose 项目' && <div className="compose-grid">{projects.map((item) => <section className="compose-card" key={`${item.name}:${item.file}`}><div className="compose-icon"><Layers /></div><span className={`status ${item.status === 'running' ? 'running' : item.status === 'partial' ? 'paused' : 'stopped'}`}><i />{item.status === 'running' ? '运行中' : item.status === 'partial' ? '部分运行' : '已停止'}</span><h2>{item.name}</h2><p>{item.services.length} 个服务 · Docker Compose</p><code className="compose-file-path">/composeFile/{item.directory}/docker-compose.yml</code><div className="compose-services">{item.services.length ? item.services.map((service) => <span key={service}><span className={item.status === 'stopped' ? 'offline-dot' : 'online-dot'} />{service}</span>) : <span className="muted">当前没有运行中的服务</span>}</div><div className="compose-actions"><Button variant="outline" disabled={busy === `view:${item.name}`} onClick={() => void openProject(item)}>查看配置</Button>{item.status === 'stopped' ? <Button variant="ghost" disabled={busy === `project:${item.name}`} onClick={() => void projectAction(item, 'start')}>启动</Button> : <Button variant="ghost" disabled={busy === `project:${item.name}`} onClick={() => void projectAction(item, 'stop')}>停止</Button>}<Button variant="ghost" disabled={busy === `project:${item.name}`} onClick={() => void projectAction(item, 'pull-up')}>更新</Button></div></section>)}{!loading && !projects.length && <div className="empty-card"><Layers size={30} /><b>还没有 Compose 项目</b><span>点击右上角“部署 Compose”创建第一个项目。</span></div>}</div>}
        {page === '加速源配置' && <section className="settings-panel mirror-manager"><div className="settings-heading"><div><div className="section-title"><Zap /><h2>镜像加速源</h2></div><p>已自动读取宿主机 Docker 当前生效的配置。你可以添加、编辑、启用或停用镜像源。</p></div><Button disabled={!mirrorCanApply || busy === 'mirrors'} onClick={() => void applyMirrorConfig()}>{busy === 'mirrors' ? '正在应用…' : '应用到宿主机'}</Button></div><div className="engine-mirror-state"><div><span className="online-dot" /><b>Docker Engine 当前生效</b></div>{activeMirrors.length ? <div className="active-mirror-tags">{activeMirrors.map((url) => <code key={url}>{url}</code>)}</div> : <span className="muted">当前未启用镜像加速源</span>}</div><div className="mirror-add"><Input aria-label="新镜像源地址" value={newMirror} onChange={(event) => setNewMirror(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addMirror(); }} placeholder="https://mirror.example.com" /><Button variant="outline" onClick={addMirror}><Plus />添加镜像源</Button></div><div className="mirror-list">{mirrorSources.map((source) => <article className={`mirror-source ${source.active ? 'is-active' : ''}`} key={source.id}><span className={source.active ? 'online-dot' : 'offline-dot'} /><Input aria-label={`编辑镜像源 ${source.url}`} value={source.url} onChange={(event) => setMirrorSources((sources) => sources.map((item) => item.id === source.id ? { ...item, url: event.target.value } : item))} /><label className="mirror-toggle"><input type="checkbox" checked={source.enabled} onChange={(event) => setMirrorSources((sources) => sources.map((item) => item.id === source.id ? { ...item, enabled: event.target.checked } : item))} /><span>{source.enabled ? '已启用' : '未启用'}</span></label>{source.active && <span className="engine-active">Engine 生效中</span>}<Button variant="ghost" size="icon" aria-label={`删除镜像源 ${source.url}`} onClick={() => setMirrorSources((sources) => sources.filter((item) => item.id !== source.id))}><Trash2 /></Button></article>)}{!mirrorSources.length && <div className="empty-mirrors"><Network /><b>还没有镜像源</b><span>添加地址后启用，并应用到宿主机。</span></div>}</div><div className="setting-note"><CircleHelp size={18} /><span>“应用到宿主机”会通过 Docker Socket 更新宿主机 daemon.json，并向 dockerd 发送热重载信号。不会重启现有容器。</span></div>{!mirrorCanApply && <p className="field-error">当前运行环境无法自动应用配置，请确认 DockerManager 以 Docker 容器方式运行并已挂载 Docker Socket。</p>}</section>}
        <footer className="main-footer"><span><Server size={14} />{system?.name || 'Docker host'} <span className="divider">/</span>{system?.architecture || '—'}</span><span>DockerManager <span className="divider">·</span> 宿主机容器管理</span></footer>
      </main></div>
    <OperationDialog modal={modal} setModal={setModal} project={project} setProject={setProject} directory={directory} setDirectory={setDirectory} compose={compose} setCompose={setCompose} existing={existing} checkingFile={checkingFile} fileChoice={fileChoice} setFileChoice={setFileChoice} projectValid={projectValid} directoryValid={directoryValid} filePath={filePath} composeIssues={composeIssues} busy={busy} deploy={deploy} action={containerAction} />
    {notice && <output className={`notice ${notice.type}`}>{notice.type === 'ok' ? <Check size={17} /> : <CircleHelp size={17} />}{notice.text}</output>}
  </div>;
}

function ContainerTable({ items, busy, loading, action, restart }: { items: Container[]; busy: string | null; loading: boolean; action: (item: Container, action: string) => Promise<void>; restart: (item: Container) => void }) {
  return <div className="table-scroll"><table><thead><tr><th>容器 / 镜像</th><th>状态</th><th>端口映射 <span className="th-sub">宿主机 → 容器</span></th><th>Compose 项目</th><th>内存</th><th className="right">操作</th></tr></thead><tbody>{items.map((item, index) => <tr key={item.id}><td><div className="container-name"><AppIcon name={item.name} color={colors[index % colors.length]} small /><div><b>{item.name}{item.update?.available && <span className="update-dot" title="镜像可升级" />}</b><small title={item.image}>{item.image}</small></div></div></td><td><span className={`status ${item.state}`}><i />{stateText(item.state)}</span></td><td><div className="ports">{item.ports.length ? item.ports.map((port, i) => <div className="port-pair" key={i}><code>{port.host ?? '—'}</code><ArrowRight size={13} /><code>{port.container}</code><span>{port.protocol}</span></div>) : <span className="muted">未映射</span>}</div></td><td><span className="project-label">{item.project && <Layers size={13} />}{item.project || '独立容器'}</span></td><td className="memory">{item.memory}</td><td><div className="row-actions">{item.state === 'running' ? <><IconButton label={`暂停 ${item.name}`} disabled={busy === `container:${item.id}`} onClick={() => void action(item, 'pause')}><Pause /></IconButton><IconButton label={`停止 ${item.name}`} disabled={busy === `container:${item.id}`} onClick={() => void action(item, 'stop')}><Square /></IconButton></> : <IconButton label={`启动或恢复 ${item.name}`} disabled={busy === `container:${item.id}`} onClick={() => void action(item, item.state === 'paused' ? 'unpause' : 'start')}><Play /></IconButton>}<IconButton label={`重启 ${item.name}`} disabled={busy === `container:${item.id}`} onClick={() => restart(item)}><RefreshCw /></IconButton></div></td></tr>)}</tbody></table>{!loading && !items.length && <div className="empty">没有匹配的容器。</div>}{loading && <div className="empty"><RefreshCw className="spin" />正在读取宿主机容器…</div>}</div>;
}

type DialogProps = { modal: Modal; setModal: (value: Modal) => void; project: string; setProject: (value: string) => void; directory: string; setDirectory: (value: string) => void; compose: string; setCompose: (value: string) => void; existing: { exists: boolean; content: string | null } | null; checkingFile: boolean; fileChoice: 'overwrite' | 'reference' | null; setFileChoice: (value: 'overwrite' | 'reference' | null) => void; projectValid: boolean; directoryValid: boolean; filePath: string; composeIssues: ReturnType<typeof validateCompose>; busy: string | null; deploy: () => Promise<void>; action: (item: Container, action: string) => Promise<void> };
function OperationDialog(props: DialogProps) {
  const { modal } = props;
  return <Dialog open={!!modal} onOpenChange={(open) => { if (!open) props.setModal(null); }}><DialogContent className={`operation-dialog ${modal?.kind === 'compose' || modal?.kind === 'view' ? 'compose-dialog' : ''}`}><DialogTitle>{modal?.kind === 'upgrade' ? '升级 latest 镜像' : modal?.kind === 'compose' ? '部署 Compose' : modal?.kind === 'view' ? 'Compose 配置' : modal?.kind === 'restart' ? '重启容器' : '使用说明'}</DialogTitle><DialogDescription>{modal?.kind === 'upgrade' ? `将拉取 ${modal.container.image} 并重建 ${modal.container.name}。` : modal?.kind === 'restart' ? `重启 ${modal.container.name} 会短暂中断服务。` : modal?.kind === 'compose' ? '文件固定保存为所选子目录下的 docker-compose.yml，部署前会执行完整配置校验。' : modal?.kind === 'view' ? `/composeFile/${modal.project.directory}/docker-compose.yml` : '所有操作均会直接作用于已连接的宿主机 Docker。'}</DialogDescription>
    {modal?.kind === 'upgrade' && <div className="confirm-info"><p><Check size={16} />保留端口、环境变量和数据卷</p><p><Layers size={16} />Compose 容器通过所属项目更新</p><p><Activity size={16} />失败时尝试恢复原容器</p></div>}
    {(modal?.kind === 'compose' || modal?.kind === 'view') && <div className="compose-workspace"><section className="compose-settings"><h3>项目配置</h3><label htmlFor="project">项目名称</label><Input id="project" value={props.project} readOnly={modal.kind === 'view'} onChange={(e) => props.setProject(e.target.value)} placeholder="例如：my-services" />{modal.kind === 'compose' && <>{props.project && !props.projectValid && <p className="field-error">项目名称格式无效。</p>}<div className="mount-info"><Server size={17} /><span>宿主机 Compose 目录<ArrowRight size={14} /><code>/composeFile</code></span></div><label htmlFor="compose-directory">保存子目录</label><div className="directory-input"><span>/composeFile/</span><Input id="compose-directory" value={props.directory} placeholder="例如：apps/nginx" aria-invalid={!!props.directory && !props.directoryValid} onChange={(e) => { props.setDirectory(e.target.value); props.setFileChoice(null); }} /></div><p className="field-hint">不能使用绝对路径或 ..。</p>{props.directory && !props.directoryValid && <p className="field-error">请输入有效的相对子目录。</p>}{props.filePath && <code className="file-destination">{props.checkingFile ? '正在检查…' : props.filePath}</code>}{props.existing?.exists && <div className="existing-file"><b>检测到已有 docker-compose.yml</b><p>{props.fileChoice === 'reference' ? '已加载现有内容，部署时不会覆盖文件。' : props.fileChoice === 'overwrite' ? '部署时会用右侧内容覆盖已有文件。' : '继续前请选择处理方式。'}</p><div><Button variant={props.fileChoice === 'overwrite' ? 'default' : 'outline'} onClick={() => props.setFileChoice('overwrite')}>覆盖已有文件</Button><Button variant={props.fileChoice === 'reference' ? 'default' : 'outline'} onClick={() => { props.setCompose(props.existing?.content || ''); props.setFileChoice('reference'); }}>引用已有内容</Button></div></div>}</>}{modal.kind === 'view' && <code className="file-destination">/composeFile/{modal.project.directory}/docker-compose.yml</code>}</section><section className="compose-editing"><ComposeEditor value={props.compose} onChange={props.setCompose} readOnly={modal.kind === 'view' || props.fileChoice === 'reference'} errorLines={props.composeIssues.map((issue) => issue.line)} /><div id="compose-validation" className={`compose-validation ${props.composeIssues.length ? 'invalid' : 'valid'}`}>{props.composeIssues.length ? <><b>检测到 {props.composeIssues.length} 处问题</b><ul>{props.composeIssues.map((issue, i) => <li key={i}><strong>第 {issue.line} 行，第 {issue.column} 列</strong><span>{issue.message}</span></li>)}</ul></> : <span><Check size={15} />YAML 语法与基础结构校验通过</span>}</div><p className="field-hint">部署前还会执行 <code>docker compose config --quiet</code>。</p></section></div>}
    {modal?.kind === 'help' && <div className="help-content"><p>容器操作会通过 Docker Socket 直接作用于宿主机。</p><p>进入页面后会拉取 latest 镜像并对比镜像 ID。</p><p>Compose 文件只允许保存在 /composeFile 的子目录中。</p></div>}
    <DialogFooter><Button variant="outline" onClick={() => props.setModal(null)}>关闭</Button>{modal?.kind === 'restart' && <Button disabled={props.busy === `container:${modal.container.id}`} onClick={() => void props.action(modal.container, 'restart')}>确认重启</Button>}{modal?.kind === 'upgrade' && <Button disabled={props.busy === `container:${modal.container.id}`} onClick={() => void props.action(modal.container, 'upgrade')}>{props.busy ? '升级中…' : '确认升级'}</Button>}{modal?.kind === 'compose' && <Button disabled={!props.projectValid || !props.directoryValid || !!props.composeIssues.length || props.checkingFile || props.busy === 'compose:deploy'} onClick={() => void props.deploy()}>{props.busy === 'compose:deploy' ? '部署中…' : props.fileChoice === 'reference' ? '引用并部署' : props.fileChoice === 'overwrite' ? '覆盖并部署' : '保存并部署'}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}

function stateText(state: Container['state']) { return state === 'running' ? '运行中' : state === 'paused' ? '已暂停' : '已停止'; }
function imageName(image: string) { return image.split(':')[0].split('/').at(-1) || image; }
function isLatest(image: string) { const last = image.split('/').at(-1) || ''; return !image.includes('@') && (!last.includes(':') || last.endsWith(':latest')); }
function AppIcon({ name, color, small = false }: { name: string; color: string; small?: boolean }) { return <div className={`app-icon ${small ? 'small' : ''} ${color}`}>{name.charAt(0).toUpperCase()}</div>; }
function Metric({ icon, label, value, detail, green, blue }: { icon: React.ReactNode; label: string; value: string | number; detail: string; green?: boolean; blue?: boolean }) { return <article className={`metric ${green ? 'green-metric' : blue ? 'blue-metric' : ''}`}><div><span>{label}</span>{icon}</div><strong>{value}<small>个</small></strong><p>{green && <span className="online-dot" />}{detail}</p></article>; }
function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) { return <Button variant="ghost" size="icon" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</Button>; }
