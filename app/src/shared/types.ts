export type State = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Artifact { path: string; kind: string; bytes: number }
export interface Event {
  schema: string; type: string; command: string; ts: string;
  [key: string]: any;
}
export interface Job {
  jobId: string; jobDir: string; command: string; shot: string; pid: number;
  state: State; phase: string; done: number; total: number | null; fps: number | null;
  etaMs: number | null; startedAt: string; updatedAt: string; result: Event | null;
  previewFrame: number | null; previewVersion: string; events: Event[]; lost?: boolean;
}
export interface Snapshot { jobs: Job[]; runningCount: number; theme: 'dark' | 'light'; select?: string }
export interface Bridge {
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
  environment(): Promise<Environment>;
  skill(host: string, action: string): Promise<{cancelled?: boolean; backup?: string | null}>;
  copyBrowserCommand(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  subscribe(fn: (snapshot: Snapshot) => void): () => void;
  stop(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  open(id: string, file?: string, reveal?: boolean): Promise<void>;
  media(id: string, file: string, version?: string): string;
}
export interface SkillConfirmation { id: number; title: string; detail: string; action: string; danger: boolean }
export interface BrowserInstallState { running: boolean; text: string }
export interface Settings { values: Record<string, any>; file: string; overrides: Record<string, string | null>; own: { theme: string; notifications: boolean; wizardDone: boolean }; version: string; packaged: boolean }
export interface Skill { host: string; target: string; detected: boolean; availableVersion: string; version: string | null; state: string }
export interface Environment { skills: Skill[]; command: { path: string | null; version: string | null; error: string | null } }
declare global { interface Window { multiplane: Bridge } }
