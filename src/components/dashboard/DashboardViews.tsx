import type { ProjectMeta } from '../../persist/projectStoreCoordinators';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { MediaCleanupDialog } from '../../media/MediaCleanupDialog';
import { ShortcutsDialog } from '../../shortcuts/ShortcutsDialog';
import { DashboardHeaderLinks } from '../DashboardHeaderLinks';
import { BrandMark, Icon, OpenChatCutWordmark } from '../icons';
import { McpGuideDialog } from '../settings/McpGuide';
import { SettingsDialog } from '../settings/SettingsDialog';
import { SkinPicker } from '../settings/SkinPicker';
import { LocaleToggle } from '../TopBar';
import {
  card, importBtn, miniBtn, modelSetupButton, modelSetupCard, modelSetupIcon,
  nameInput, newCard, searchBox, searchClear, searchEmpty, searchIcon, searchInput,
  settingsBtn, thumb,
} from './dashboardStyles';
import { relativeProjectTime, type DashboardModel, type DashboardProps } from './useDashboardModel';

function ModelSetupCard({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <section role="status" style={modelSetupCard}>
      <span style={modelSetupIcon}><Icon name="sparkles" size={18} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', color: theme.textStrong, fontSize: 13.5 }}>{t('配置模型后开始使用 Agent')}</strong>
        <span style={{ display: 'block', marginTop: 3, color: theme.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
          {t('配置任一云端或本地模型，即可在编辑器中使用对话式剪辑。')}
        </span>
      </span>
      <button type="button" onClick={onOpen} style={modelSetupButton}>{t('配置模型')}</button>
    </section>
  );
}

function ProjectSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  return (
    <label style={searchBox}>
      <span style={searchIcon}><Icon name="search" size={13} /></span>
      <input
        type="search"
        aria-label={t('搜索工程')}
        placeholder={t('搜索工程')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onChange(''); }}
        autoComplete="off"
        spellCheck={false}
        style={searchInput}
      />
      {value && <button type="button" onClick={() => onChange('')} aria-label={t('清除搜索')} style={searchClear}><Icon name="x" size={12} /></button>}
    </label>
  );
}

export function DashboardTitlebarContent({ model }: { model: DashboardModel }) {
  const t = useT();
  return (
    <>
      <BrandMark size={20} />
      <OpenChatCutWordmark />
      <span style={{ color: theme.textDim, fontSize: 13 }}>{t('· 我的工程')}</span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <DashboardHeaderLinks />
        <button onClick={() => model.setDialog('mcp', true)} data-tip={t('外部 Agent 接入 (MCP)')} aria-label={t('外部 Agent 接入 (MCP)')} className="cc-header-btn cc-tip cc-tip-r" style={settingsBtn}><Icon name="plug" size={16} /></button>
        <button onClick={() => model.setDialog('shortcuts', true)} data-tip={t('编辑快捷键')} aria-label={t('编辑快捷键')} className="cc-header-btn cc-tip cc-tip-r" style={settingsBtn}><Icon name="keyboard" size={16} /></button>
        <LocaleToggle />
        <SkinPicker />
        <button onClick={() => model.setDialog('settings', true)} data-tip={t('设置 · API 密钥')} aria-label={t('设置 · API 密钥')} className="cc-header-btn cc-tip cc-tip-r" style={settingsBtn}><Icon name="sliders" size={16} /></button>
      </span>
    </>
  );
}

function ProjectToolbar({ projects, model }: { projects: ProjectMeta[]; model: DashboardModel }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{t('工程')}</h1>
      {model.transfer.note && <span style={{ color: theme.textDim, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.transfer.note}</span>}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <ProjectSearch value={model.query} onChange={model.setQuery} />
        <button onClick={() => model.setDialog('cleanup', true)} style={importBtn} title={t('清理所有工程都不引用的上传素材(测试/已删工程残留)')}><Icon name="trash" size={13} /> {t('清理素材')}</button>
        <button onClick={() => model.transfer.fileRef.current?.click()} disabled={model.transfer.busy} style={importBtn} title={t('导入 .ccproj 工程文件(兼容旧 .ccproj.json)')}><Icon name="upload" size={13} /> {t('导入工程')}</button>
        <input ref={model.transfer.fileRef} type="file" accept=".ccproj,.json,application/json,application/x-openchatcut-project" onChange={model.transfer.pickImport} style={{ display: 'none' }} />
        <span style={{ color: theme.textDim, fontSize: 12.5 }}>
          {model.normalizedQuery
            ? t('{n} / {total} 个', { n: model.visibleProjects.length, total: projects.length })
            : t('{n} 个', { n: projects.length })}
        </span>
      </span>
    </div>
  );
}

function ProjectName({ project, model }: { project: ProjectMeta; model: DashboardModel }) {
  const t = useT();
  if (model.rename.editingId === project.id) {
    return <input
      autoFocus
      value={model.rename.draft}
      onChange={(event) => model.rename.setDraft(event.target.value)}
      onBlur={model.rename.commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') model.rename.commit();
        if (event.key === 'Escape') model.rename.cancel();
      }}
      style={nameInput}
    />;
  }
  return <div onDoubleClick={() => model.rename.start(project)} title={t('双击重命名')} style={{ fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</div>;
}

function ProjectActions({ project, props, model }: { project: ProjectMeta; props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  if (model.rename.confirmId === project.id) {
    return <button
      onClick={() => {
        void model.transfer.run(props.onDelete(project.id).then(() => t('已永久删除「{name}」', { name: project.name })));
        model.rename.setConfirmId(null);
      }}
      disabled={model.transfer.busy}
      style={{ ...miniBtn, color: '#f77' }}
      title={t('彻底删除工程,并清掉只有它引用的素材文件')}
    >{t('确认删除')}</button>;
  }
  return (
    <>
      <button onClick={() => model.rename.start(project)} style={miniBtn} title={t('重命名')}><Icon name="pencil" size={13} /></button>
      <button onClick={() => props.onDuplicate(project.id)} style={miniBtn} title={t('复制')}><Icon name="copy" size={13} /></button>
      <button onClick={() => void model.transfer.run(props.onExport(project.id, project.name))} disabled={model.transfer.busy} style={miniBtn} title={t('导出为流式 .ccproj(含素材,可在桌面版/其它机器导入)')}><Icon name="download" size={13} /></button>
      <button onClick={() => model.rename.setConfirmId(project.id)} style={miniBtn} title={t('删除')}><Icon name="trash" size={13} /></button>
    </>
  );
}

function ProjectCard({ project, props, model }: { project: ProjectMeta; props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  return (
    <div style={card}>
      <button onClick={() => props.onOpen(project.id)} style={thumb} title={t('打开 {name}', { name: project.name })}>
        {model.thumbs[project.id]
          ? <img src={model.thumbs[project.id]} alt="" draggable={false} loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          : <span style={{ color: theme.borderLight, display: 'inline-flex' }}><Icon name="play" size={26} /></span>}
      </button>
      <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <ProjectName project={project} model={model} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{relativeProjectTime(project.updatedAt, t)}</span>
          <div style={{ display: 'flex', gap: 2 }} className="acts"><ProjectActions project={project} props={props} model={model} /></div>
        </div>
      </div>
    </div>
  );
}

function ProjectGrid({ props, model }: { props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', alignItems: 'start', gap: 16 }}>
        <button onClick={props.onNew} style={newCard} title={t('新建工程')}>
          <span style={{ fontSize: 30, color: theme.textDim, lineHeight: 1 }}>＋</span>
          <span style={{ fontSize: 13, color: theme.textDim }}>{t('新建工程')}</span>
        </button>
        {model.visibleProjects.map((project) => <ProjectCard key={project.id} project={project} props={props} model={model} />)}
      </div>
      {model.normalizedQuery && model.visibleProjects.length === 0 && (
        <div role="status" style={searchEmpty}><Icon name="search" size={14} />{t('没有找到匹配“{query}”的工程', { query: model.query.trim() })}</div>
      )}
    </>
  );
}

export function DashboardContent({ props, model }: { props: DashboardProps; model: DashboardModel }) {
  return (
    <main style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 24px 80px' }}>
        {model.modelSnapshot.loaded && model.modelSnapshot.choices.length === 0 && <ModelSetupCard onOpen={() => model.setDialog('settings', true)} />}
        <ProjectToolbar projects={props.projects} model={model} />
        <ProjectGrid props={props} model={model} />
      </div>
    </main>
  );
}

export function DashboardDialogs({ model }: { model: DashboardModel }) {
  return (
    <>
      {model.dialogs.settings && <SettingsDialog onClose={() => model.setDialog('settings', false)} />}
      {model.dialogs.shortcuts && <ShortcutsDialog onClose={() => model.setDialog('shortcuts', false)} />}
      {model.dialogs.mcp && <McpGuideDialog onClose={() => model.setDialog('mcp', false)} />}
      {model.dialogs.cleanup && <MediaCleanupDialog onClose={() => model.setDialog('cleanup', false)} />}
    </>
  );
}
