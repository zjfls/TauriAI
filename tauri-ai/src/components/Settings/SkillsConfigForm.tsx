/**
 * SkillsConfigForm
 * - Discover skills from multiple roots
 * - Manage global enable/disable and skill sets
 * - Create skills via backend command (for future AI procedural creation)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Plus, RefreshCw, FileText, Layers, X, Save } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { countTokens } from '../../utils/tokenizer';
import type {
  AppConfig,
  SkillEntry,
  SkillLoadOutcome,
  SkillRootsSnapshot,
  SkillSetConfig,
} from '../../types';

type ActiveTab = 'skills' | 'sets';

type CreateSkillForm = {
  target: 'app' | 'workstudio';
  workstudioMainFolder: string;
  category: string;
  name: string;
  description: string;
  shortDescription: string;
  body: string;
  overwrite: boolean;
};

const defaultCreateForm = (): CreateSkillForm => ({
  target: 'app',
  workstudioMainFolder: '',
  category: 'learn',
  name: '',
  description: '',
  shortDescription: '',
  body: '',
  overwrite: false,
});

const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

export const SkillsConfigForm: React.FC = () => {
  const { config, saveConfig } = useConfigStore();
  const [activeTab, setActiveTab] = useState<ActiveTab>('skills');

  const [roots, setRoots] = useState<SkillRootsSnapshot | null>(null);
  const [outcome, setOutcome] = useState<SkillLoadOutcome | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [workstudioMainFolder, setWorkstudioMainFolder] = useState<string>('');

  const [selectedSkill, setSelectedSkill] = useState<SkillEntry | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateSkillForm>(() => defaultCreateForm());

  const disabledSkills = config?.skills?.disabledSkills ?? [];
  const sets = config?.skills?.sets ?? [];

  const refresh = async () => {
    setIsLoading(true);
    try {
      const res = await invoke<[SkillRootsSnapshot, SkillLoadOutcome]>('list_skills', {
        args: {
          workstudioMainFolder: workstudioMainFolder.trim() || undefined,
          includeContents: true,
        },
      });
      setRoots(res[0]);
      setOutcome(res[1]);
    } catch (e) {
      console.error('list_skills failed:', e);
      setRoots(null);
      setOutcome({ skills: [], errors: [String(e)] });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Realtime refresh
    let unlisten: null | (() => void) = null;
    void listen('skills:changed', () => {
      void refresh();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workstudioMainFolder]);

  const skills = outcome?.skills ?? [];

  const grouped = useMemo(() => {
    const byCat = new Map<string, SkillEntry[]>();
    for (const s of skills) {
      const cat = s.meta.category || 'uncategorized';
      byCat.set(cat, [...(byCat.get(cat) ?? []), s]);
    }
    return Array.from(byCat.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [skills]);

  const enabledTotalTokens = useMemo(() => {
    const disabled = new Set(disabledSkills);
    return skills
      .filter((s) => !disabled.has(s.meta.name))
      .reduce((sum, s) => sum + countTokens(s.contents || ''), 0);
  }, [skills, disabledSkills]);

  if (!config) {
    return <div className="text-sm text-gray-500 dark:text-gray-400">加载配置中...</div>;
  }

  const updateConfig = (next: AppConfig) => saveConfig(next);

  const toggleSkillEnabled = (name: string) => {
    const set = new Set(disabledSkills);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    updateConfig({ ...config, skills: { ...config.skills, disabledSkills: Array.from(set) } });
  };

  const upsertSet = (set: SkillSetConfig) => {
    const name = set.name.trim();
    if (!name) return;
    const next = [...sets];
    const idx = next.findIndex((s) => s.name === name);
    const normalized: SkillSetConfig = {
      name,
      enabled: set.enabled ?? true,
      skills: uniq(set.skills ?? []),
      disabledSkills: uniq(set.disabledSkills ?? []),
    };
    if (idx >= 0) next[idx] = normalized;
    else next.push(normalized);
    updateConfig({ ...config, skills: { ...config.skills, sets: next } });
  };

  const deleteSet = (name: string) => {
    updateConfig({
      ...config,
      skills: { ...config.skills, sets: sets.filter((s) => s.name !== name) },
    });
  };

  const allSkillNames = useMemo(() => skills.map((s) => s.meta.name), [skills]);

  const createSkill = async () => {
    try {
      const res = await invoke<string>('create_skill', {
        args: {
          target: createForm.target,
          workstudioMainFolder:
            createForm.target === 'workstudio' ? createForm.workstudioMainFolder.trim() : undefined,
          category: createForm.category,
          name: createForm.name,
          description: createForm.description,
          shortDescription: createForm.shortDescription.trim() || undefined,
          body: createForm.body,
          overwrite: createForm.overwrite,
        },
      });
      console.log('created skill:', res);
      setCreateOpen(false);
      setCreateForm(defaultCreateForm());
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">Skills</h2>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            已启用技能提示词开销（估算）：{enabledTotalTokens} tokens
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            <Plus size={16} />
            创建技能
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="刷新"
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/60">
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <span className="font-medium">Roots:</span>
          <span className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-800">
            app: {roots?.appSkillsDir ?? '-'}
          </span>
          <span className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-800">
            repo: {roots?.repoSkillsDir ?? '-'}
          </span>
          <span className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-800">
            workstudio: {roots?.workstudioSkillsDir ?? '-'}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={workstudioMainFolder}
            onChange={(e) => setWorkstudioMainFolder(e.target.value)}
            placeholder="可选：填入 workstudio 主文件夹路径以加载其 skills/"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
          />
        </div>
      </div>

      <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setActiveTab('skills')}
          className={[
            'px-3 py-1.5 text-sm transition-colors',
            activeTab === 'skills'
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
          ].join(' ')}
        >
          <FileText size={16} className="inline-block mr-1" />
          全部技能（{skills.length}）
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sets')}
          className={[
            'px-3 py-1.5 text-sm transition-colors border-l border-gray-200 dark:border-gray-700',
            activeTab === 'sets'
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
          ].join(' ')}
        >
          <Layers size={16} className="inline-block mr-1" />
          Skill Sets（{sets.length}）
        </button>
      </div>

      {isLoading && <div className="text-sm text-gray-500 dark:text-gray-400">加载中...</div>}

      {outcome?.errors?.length ? (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-900/20 dark:text-yellow-100">
          <div className="font-medium">发现/解析错误</div>
          <ul className="mt-2 list-disc pl-5">
            {outcome.errors.map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {activeTab === 'skills' && (
        <div className="space-y-4">
          {grouped.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">暂无技能（请在 skills/ 下添加 SKILL.md）</div>
          ) : (
            grouped.map(([cat, list]) => (
              <div key={cat} className="space-y-2">
                <div className="text-sm font-semibold text-gray-800 dark:text-white">{cat}</div>
                <div className="grid grid-cols-1 gap-2">
                  {list.map((s) => {
                    const enabled = !disabledSkills.includes(s.meta.name);
                    const tok = countTokens(s.contents || '');
                    return (
                      <div
                        key={s.meta.path}
                        className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900/60"
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedSkill(s)}
                          title={s.meta.path}
                        >
                          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                            {s.meta.name}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                            {s.meta.shortDescription || s.meta.description}
                          </div>
                          <div className="mt-1 text-[11px] text-gray-400">
                            tokens: {tok} · root: {s.meta.rootKind}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSkillEnabled(s.meta.name)}
                          className={[
                            'relative h-6 w-11 rounded-full transition-colors',
                            enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700',
                          ].join(' ')}
                          title={enabled ? '已启用，点击禁用' : '已禁用，点击启用'}
                        >
                          <span
                            className={[
                              'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                              enabled ? 'translate-x-5' : '',
                            ].join(' ')}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'sets' && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() =>
              upsertSet({
                name: `skill_set_${Date.now()}`,
                enabled: true,
                skills: [],
                disabledSkills: [],
              })
            }
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            <Plus size={16} />
            新建 Skill Set
          </button>

          {sets.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">暂无 skill set</div>
          ) : (
            <div className="space-y-3">
              {sets.map((set) => {
                const enabled = set.enabled ?? true;
                return (
                  <div
                    key={set.name}
                    className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900/60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <input
                          value={set.name}
                          onChange={(e) => upsertSet({ ...set, name: e.target.value })}
                          className="w-64 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        />
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          skills: {set.skills.length}（禁用: {set.disabledSkills.length}）
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => upsertSet({ ...set, enabled: !enabled })}
                          className={[
                            'relative h-6 w-11 rounded-full transition-colors',
                            enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700',
                          ].join(' ')}
                          title={enabled ? '已启用 set' : '已关闭 set'}
                        >
                          <span
                            className={[
                              'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                              enabled ? 'translate-x-5' : '',
                            ].join(' ')}
                          />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteSet(set.name)}
                          className="rounded-lg border border-red-200 bg-white px-2 py-1 text-sm text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-gray-950 dark:text-red-300 dark:hover:bg-red-900/20"
                          title="删除"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-2">
                      <div className="text-xs font-medium text-gray-700 dark:text-gray-300">选择技能</div>
                      <div className="max-h-64 overflow-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                        {allSkillNames.length === 0 ? (
                          <div className="text-xs text-gray-500 dark:text-gray-400">暂无可选技能</div>
                        ) : (
                          allSkillNames.map((name) => {
                            const inSet = set.skills.includes(name);
                            const disabledInSet = set.disabledSkills.includes(name);
                            return (
                              <div key={name} className="flex items-center justify-between gap-2 py-1">
                                <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
                                  <input
                                    type="checkbox"
                                    checked={inSet}
                                    onChange={() => {
                                      const nextSkills = inSet
                                        ? set.skills.filter((x) => x !== name)
                                        : [...set.skills, name];
                                      const nextDisabled = set.disabledSkills.filter((x) => x !== name);
                                      upsertSet({ ...set, skills: nextSkills, disabledSkills: nextDisabled });
                                    }}
                                  />
                                  <span className="font-mono text-xs">{name}</span>
                                </label>
                                <button
                                  type="button"
                                  disabled={!inSet}
                                  onClick={() => {
                                    if (!inSet) return;
                                    const next = disabledInSet
                                      ? set.disabledSkills.filter((x) => x !== name)
                                      : [...set.disabledSkills, name];
                                    upsertSet({ ...set, disabledSkills: next });
                                  }}
                                  className={[
                                    'rounded px-2 py-0.5 text-[11px] border',
                                    !inSet
                                      ? 'border-gray-200 text-gray-400 dark:border-gray-800 dark:text-gray-600'
                                      : disabledInSet
                                        ? 'border-yellow-300 text-yellow-700 bg-yellow-50 dark:border-yellow-900/50 dark:text-yellow-200 dark:bg-yellow-900/20'
                                        : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
                                  ].join(' ')}
                                  title="在 set 内临时禁用/启用"
                                >
                                  {disabledInSet ? 'Set内禁用' : 'Set内启用'}
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                        说明：全局禁用（上面的开关）优先于 set；set 内禁用用于临时屏蔽某个技能。
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Skill detail modal */}
      {selectedSkill && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedSkill(null)} />
          <div className="absolute left-1/2 top-12 w-[900px] max-w-[95vw] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {selectedSkill.meta.name}
                </div>
                <div className="mt-0.5 truncate text-xs text-gray-500" title={selectedSkill.meta.path}>
                  {selectedSkill.meta.path}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSkill(null)}
                className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <X size={12} />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-auto p-4">
              <div className="text-sm text-gray-700 dark:text-gray-200">
                <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  tokens: {countTokens(selectedSkill.contents || '')} · category: {selectedSkill.meta.category} · root:{' '}
                  {selectedSkill.meta.rootKind}
                </div>
                <pre className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                  {selectedSkill.contents}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setCreateOpen(false)} />
          <div className="absolute left-1/2 top-10 w-[860px] max-w-[95vw] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">创建技能</div>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <X size={12} />
              </button>
            </div>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-600 dark:text-gray-300">
                  目标目录
                  <select
                    value={createForm.target}
                    onChange={(e) =>
                      setCreateForm((p) => ({ ...p, target: e.target.value as 'app' | 'workstudio' }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  >
                    <option value="app">应用目录（~/.tauri-ai/skills）</option>
                    <option value="workstudio">Workstudio 主文件夹（&lt;main&gt;/skills）</option>
                  </select>
                </label>
                <label className="text-xs text-gray-600 dark:text-gray-300">
                  分类（目录）
                  <input
                    value={createForm.category}
                    onChange={(e) => setCreateForm((p) => ({ ...p, category: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    placeholder="learn/system/code"
                  />
                </label>
              </div>

              {createForm.target === 'workstudio' && (
                <label className="text-xs text-gray-600 dark:text-gray-300">
                  workstudio 主文件夹路径
                  <input
                    value={createForm.workstudioMainFolder}
                    onChange={(e) => setCreateForm((p) => ({ ...p, workstudioMainFolder: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    placeholder="/path/to/workspace"
                  />
                </label>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-600 dark:text-gray-300">
                  名称（name）
                  <input
                    value={createForm.name}
                    onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    placeholder="deep-learning"
                  />
                </label>
                <label className="text-xs text-gray-600 dark:text-gray-300">
                  简短描述（short-description，可选）
                  <input
                    value={createForm.shortDescription}
                    onChange={(e) => setCreateForm((p) => ({ ...p, shortDescription: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </label>
              </div>

              <label className="text-xs text-gray-600 dark:text-gray-300">
                描述（description）
                <input
                  value={createForm.description}
                  onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
              </label>

              <label className="text-xs text-gray-600 dark:text-gray-300">
                内容（SKILL.md body）
                <textarea
                  value={createForm.body}
                  onChange={(e) => setCreateForm((p) => ({ ...p, body: e.target.value }))}
                  className="mt-1 h-56 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                />
              </label>

              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={createForm.overwrite}
                  onChange={(e) => setCreateForm((p) => ({ ...p, overwrite: e.target.checked }))}
                />
                覆盖同名目录下现有 SKILL.md
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void createSkill()}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                >
                  <Save size={16} />
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
