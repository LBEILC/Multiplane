export type State = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Artifact { path: string; kind: string; bytes: number }
export interface Event {
  schema: string; type: string; command: string; ts: string;
  [key: string]: any;
}
export interface Job {
  jobId: string; jobDir: string; command: string; shot: string; pid: number;
  state: State; phase: string; done: number; total: number | null; fps: number | null;
  etaMs: number | null; startedAt: string; updatedAt: string; result: Event | null;
  previewFrame: number | null; previewVersion: string; events: Event[]; lost?: boolean; hosted?: boolean; queuePosition?: number; stuck?: boolean; forced?: boolean; temporaryDirectories?: string[];
}
export interface Snapshot { hosted?: boolean; language?: string; languagePreference?: string; jobs: Job[]; runningCount: number; theme: 'dark' | 'light'; select?: string }
export interface Bridge {
  updateState(): Promise<UpdateState>;
  checkUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  openRelease(): Promise<void>;
  onUpdateState(fn: (state: UpdateState) => void): () => void;
  reportFault(message: string): void;
  platform(): Promise<{ platform: string; home: string }>;
  browserInstallState(): Promise<BrowserInstallState>;
  installBrowser(): Promise<void>;
  cancelBrowserInstall(): Promise<void>;
  onBrowserInstallState(fn: (state: BrowserInstallState) => void): () => void;
  onSkillConfirmation(fn: (confirmation: SkillConfirmation) => void): () => void;
  answerSkillConfirmation(id: number, accepted: boolean): Promise<void>;
  settings(): Promise<Settings>;
  saveSetting(key: string, value: unknown, own?: boolean): Promise<Settings>;
  chooseSetting(key: string): Promise<Settings>;
  openConfig(): Promise<void>;
  doctor(): Promise<Event>;
  checkFfmpeg(): Promise<{ name: string; ok: boolean; detail: string; reason?: string; diagnostic?: string }>;
  environment(): Promise<Environment>;
  skill(host: string, action: string): Promise<{cancelled?: boolean; backup?: string | null}>;
  copyBundledCommand(): Promise<void>;
  copyBrowserCommand(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  subscribe(fn: (snapshot: Snapshot) => void): () => void;
  stop(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  open(id: string, file?: string, reveal?: boolean): Promise<void>;
  media(id: string, file: string, version?: string): string;
}
export interface SkillConfirmation { id: number; title: string; detail: string; action: string; danger: boolean; titleKey?: string; detailKey?: string; actionKey?: string; values?: Record<string, string> }
export interface BrowserInstallState { running: boolean; text: string }
export interface UpdateState { phase: 'idle' | 'development' | 'checking' | 'current' | 'available' | 'manual' | 'downloading' | 'downloaded' | 'error'; currentVersion: string; version: string; canInstall: boolean; checkedAt: string; publishedAt: string; notes: string; releaseUrl: string; percent: number; transferred: number; total: number; errorStage: string }
export interface Settings { check?: { usable: boolean; version: string | null; reason: string | null; encoders: Record<string, boolean> }; values: Record<string, any>; file: string; overrides: Record<string, string | null>; own: { autoCheckUpdates?: boolean; language?: string; theme: string; notifications: boolean; wizardDone: boolean }; version: string; packaged: boolean }
export interface Skill { blocked?: boolean; error?: string | null; host: string; target: string; detected: boolean; availableVersion: string; version: string | null; state: string }
export interface Environment { skills: Skill[]; command: { bundled?: string | null; path: string | null; version: string | null; error: string | null } }
declare global { interface Window { multiplane: Bridge } }
