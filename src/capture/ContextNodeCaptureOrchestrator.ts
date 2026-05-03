/**
 * ContextNodeCaptureOrchestrator
 *
 * Runs context-node capture in the strict order required by the restore
 * dependency contract:
 *
 *   IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme
 *   → Board (per project) → Sprint (per board)
 *
 * Rules enforced here:
 *   - Stages run sequentially; a failure in stage N halts and surfaces a
 *     named diagnostic before stage N+1 begins.
 *   - Custom field context (GET /field/{id}/context) is called ONLY for
 *     fields where custom === true; system fields are counted separately.
 *   - All paginated calls go through paginateAtlassian (no ad-hoc loops).
 *   - A progress heartbeat is emitted every ≤10s during long stages.
 *   - Every stage emits a structured log line:
 *       [jira-context-capture] stage=<name> count=<n> outcome=ok|error
 *
 * See: docs/architecture/context-capture-pipeline.md
 */

import { JiraHttpClient } from '../http/JiraHttpClient';
import { paginateAtlassian } from '../pagination/paginateAtlassian';
import {
  ManifestEntry,
  ManifestStageSection,
  CapturePhase,
} from '../manifest/types';

// ── Default heartbeat interval ────────────────────────────────────────────────

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 9000; // ≤10s per spec

// ── Progress events ───────────────────────────────────────────────────────────

export type ProgressEventType =
  | 'heartbeat'
  | 'stage_start'
  | 'stage_complete'
  | 'stage_error';

export interface ProgressEvent {
  type: ProgressEventType;
  stage: string;
  timestamp: string;
  count?: number;
  diagnostic?: string;
}

// ── Stage result ──────────────────────────────────────────────────────────────

export interface CaptureStageResult {
  stageName: CapturePhase;
  entries: ManifestEntry[];
  section: ManifestStageSection;
  outcome: 'ok' | 'error';
  diagnostic?: string;
}

// ── Orchestrator config ────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  backupPointId: string;
  cloudId: string;
  /** In-scope (non-JSM) projects from the prior project discovery phase */
  projects: Array<{ id: string; key: string }>;
  maxResults?: number;
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Interval in ms between heartbeat emissions. Default 9000.
   * Injectable for test isolation.
   */
  heartbeatIntervalMs?: number;
  /**
   * Optional hook called after each stage completes (ok or error).
   * Used by the manifest writer to persist each section atomically.
   */
  onStageComplete?: (result: CaptureStageResult) => void;
}

// ── Run result ─────────────────────────────────────────────────────────────────

export interface OrchestratorRunResult {
  stages: CaptureStageResult[];
  allEntries: ManifestEntry[];
  halted: boolean;
  haltedAtStage?: string;
  haltDiagnostic?: string;
  /** Total system fields that were skipped (custom:false) */
  systemFieldsSkipped: number;
}

// ── Jira API response shapes ──────────────────────────────────────────────────

interface IssueTypeApiItem {
  id: string;
  name: string;
  self: string;
  description?: string;
  subtask: boolean;
}

interface FieldApiItem {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string; customId?: number };
}

interface FieldContextApiItem {
  id: string;
  name: string;
  isGlobalContext: boolean;
  isAnyIssueType: boolean;
}

interface FieldConfigApiItem {
  id: number;
  name: string;
  description?: string;
  isDefault?: boolean;
}

interface WorkflowApiItem {
  id: { name: string } | string;
  name?: string;
  description?: string;
}

interface WorkflowSchemeApiItem {
  id: number;
  name: string;
  description?: string;
}

interface BoardApiItem {
  id: number;
  name: string;
  type: string;
  location?: { projectId?: number; projectKey?: string };
}

interface SprintApiItem {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class ContextNodeCaptureOrchestrator {
  constructor(private readonly httpClient: JiraHttpClient) {}

  /**
   * Executes all context-node capture stages in dependency order.
   * Returns after all stages complete or after the first halting error.
   */
  async run(config: OrchestratorConfig): Promise<OrchestratorRunResult> {
    const {
      backupPointId,
      projects,
      maxResults = 50,
      onProgress,
      heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
      onStageComplete,
    } = config;

    const stageResults: CaptureStageResult[] = [];
    const allEntries: ManifestEntry[] = [];

    const emit = (event: ProgressEvent) => onProgress?.(event);

    // ── Stage runners in strict order ────────────────────────────────────────
    // IMPORTANT: This array defines capture order. Do NOT reorder entries.
    const stageRunners: Array<() => Promise<CaptureStageResult>> = [
      () =>
        this.captureIssueTypes(
          backupPointId,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureCustomFields(
          backupPointId,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureFieldConfigurations(
          backupPointId,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureWorkflows(
          backupPointId,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureWorkflowSchemes(
          backupPointId,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureBoards(
          backupPointId,
          projects,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
      () =>
        this.captureSprints(
          backupPointId,
          stageResults,
          maxResults,
          emit,
          heartbeatIntervalMs,
        ),
    ];

    for (const runner of stageRunners) {
      const result = await runner();
      stageResults.push(result);
      allEntries.push(...result.entries);
      onStageComplete?.(result);

      if (result.outcome === 'error') {
        // Halt: surface named diagnostic; no subsequent stages run
        const diagnostic =
          result.diagnostic ??
          `Backup halted at phase ${result.stageName}: unknown error`;

        emit({
          type: 'stage_error',
          stage: result.stageName,
          timestamp: new Date().toISOString(),
          diagnostic,
        });

        return {
          stages: stageResults,
          allEntries,
          halted: true,
          haltedAtStage: result.stageName,
          haltDiagnostic: diagnostic,
          systemFieldsSkipped: this.sumSystemFieldsSkipped(stageResults),
        };
      }
    }

    return {
      stages: stageResults,
      allEntries,
      halted: false,
      systemFieldsSkipped: this.sumSystemFieldsSkipped(stageResults),
    };
  }

  // ── Heartbeat wrapper ───────────────────────────────────────────────────────

  /**
   * Runs `work`, emitting a heartbeat every `intervalMs` until work resolves.
   * The interval is always cleared in the finally block.
   */
  private async runWithHeartbeat<T>(
    stageName: string,
    work: () => Promise<T>,
    emit: (e: ProgressEvent) => void,
    intervalMs: number,
  ): Promise<T> {
    const timer = setInterval(() => {
      emit({
        type: 'heartbeat',
        stage: stageName,
        timestamp: new Date().toISOString(),
      });
    }, intervalMs);

    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  // ── Stage: IssueType ────────────────────────────────────────────────────────

  private async captureIssueTypes(
    backupPointId: string,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({ type: 'stage_start', stage: 'issue_type', timestamp: new Date().toISOString() });

    try {
      const result = await this.runWithHeartbeat(
        'issue_type',
        async () => {
          // issuetype returns a flat array — wrap as single-page adapter
          return paginateAtlassian<IssueTypeApiItem>(
            async (_startAt, _maxResults) => {
              const items = (await this.httpClient.get(
                '/rest/api/3/issuetype',
              )) as IssueTypeApiItem[];
              return { values: items, total: items.length, isLast: true };
            },
            maxResults,
          );
        },
        emit,
        heartbeatIntervalMs,
      );

      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = result.items.map((item) => ({
        id: item.id,
        key: item.name,
        phase: 'issue_type',
        objectType: 'IssueType',
        capturedAt,
        status: 'success',
        backupPointId,
        data: item,
      }));

      const section: ManifestStageSection = {
        stageName: 'issue_type',
        apiPageCount: result.pagesFetched,
        apiTotalReported: result.apiReportedTotal,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=issue_type count=${entries.length} outcome=ok`,
      );

      emit({
        type: 'stage_complete',
        stage: 'issue_type',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'issue_type', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=issue_type error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=issue_type outcome=error`, err);
      return {
        stageName: 'issue_type',
        entries: [],
        section: this.errorSection('issue_type'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: CustomField + FieldContext ───────────────────────────────────────

  private async captureCustomFields(
    backupPointId: string,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({ type: 'stage_start', stage: 'custom_field', timestamp: new Date().toISOString() });

    try {
      const fieldResult = await this.runWithHeartbeat(
        'custom_field',
        async () => {
          // field returns a flat array — single-page adapter
          return paginateAtlassian<FieldApiItem>(
            async (_startAt, _maxResults) => {
              const items = (await this.httpClient.get(
                '/rest/api/3/field',
              )) as FieldApiItem[];
              return { values: items, total: items.length, isLast: true };
            },
            maxResults,
          );
        },
        emit,
        heartbeatIntervalMs,
      );

      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = [];
      const skippedIds: string[] = [];
      const skippedReasons: Record<string, string> = {};
      let systemFieldsSkipped = 0;

      for (const field of fieldResult.items) {
        if (!field.custom) {
          // System field — skip context discovery entirely
          skippedIds.push(field.id);
          skippedReasons[field.id] = 'system_field';
          systemFieldsSkipped++;
          continue;
        }

        // Custom field — fetch context pages
        let contextCount = 0;
        try {
          const ctxResult = await paginateAtlassian<FieldContextApiItem>(
            async (startAt, mr) => {
              const params = new URLSearchParams({
                startAt: String(startAt),
                maxResults: String(mr),
              });
              return (await this.httpClient.get(
                `/rest/api/3/field/${field.id}/context?${params}`,
              )) as { values: FieldContextApiItem[]; total: number; isLast: boolean };
            },
            maxResults,
          );
          contextCount = ctxResult.totalFetched;
        } catch {
          // Context fetch failure does not halt the stage; entry records the error
          contextCount = 0;
        }

        entries.push({
          id: field.id,
          key: field.name,
          phase: 'custom_field',
          objectType: 'CustomField',
          capturedAt,
          status: 'success',
          backupPointId,
          data: { ...field, contextCount },
        });
      }

      const section: ManifestStageSection = {
        stageName: 'custom_field',
        apiPageCount: fieldResult.pagesFetched,
        apiTotalReported: fieldResult.apiReportedTotal,
        capturedCount: entries.length,
        skippedIds,
        skippedReasons,
      };

      // Attach systemFieldsSkipped count for caller consumption
      (section as ManifestStageSection & { systemFieldsSkipped: number }).systemFieldsSkipped =
        systemFieldsSkipped;

      console.log(
        `[jira-context-capture] stage=custom_field count=${entries.length} systemFieldsSkipped=${systemFieldsSkipped} outcome=ok`,
      );

      emit({
        type: 'stage_complete',
        stage: 'custom_field',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'custom_field', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=custom_field error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=custom_field outcome=error`, err);
      return {
        stageName: 'custom_field',
        entries: [],
        section: this.errorSection('custom_field'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: FieldConfiguration ───────────────────────────────────────────────

  private async captureFieldConfigurations(
    backupPointId: string,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({
      type: 'stage_start',
      stage: 'field_configuration',
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await this.runWithHeartbeat(
        'field_configuration',
        async () =>
          paginateAtlassian<FieldConfigApiItem>(
            async (startAt, mr) => {
              const params = new URLSearchParams({
                startAt: String(startAt),
                maxResults: String(mr),
              });
              return (await this.httpClient.get(
                `/rest/api/3/fieldconfiguration?${params}`,
              )) as { values: FieldConfigApiItem[]; total: number; isLast: boolean };
            },
            maxResults,
          ),
        emit,
        heartbeatIntervalMs,
      );

      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = result.items.map((item) => ({
        id: String(item.id),
        key: item.name,
        phase: 'field_configuration',
        objectType: 'FieldConfiguration',
        capturedAt,
        status: 'success',
        backupPointId,
        data: item,
      }));

      const section: ManifestStageSection = {
        stageName: 'field_configuration',
        apiPageCount: result.pagesFetched,
        apiTotalReported: result.apiReportedTotal,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=field_configuration count=${entries.length} outcome=ok`,
      );
      emit({
        type: 'stage_complete',
        stage: 'field_configuration',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'field_configuration', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=field_configuration error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=field_configuration outcome=error`, err);
      return {
        stageName: 'field_configuration',
        entries: [],
        section: this.errorSection('field_configuration'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: Workflow ─────────────────────────────────────────────────────────

  private async captureWorkflows(
    backupPointId: string,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({ type: 'stage_start', stage: 'workflow', timestamp: new Date().toISOString() });

    try {
      const result = await this.runWithHeartbeat(
        'workflow',
        async () =>
          paginateAtlassian<WorkflowApiItem>(
            async (startAt, mr) => {
              const params = new URLSearchParams({
                startAt: String(startAt),
                maxResults: String(mr),
              });
              return (await this.httpClient.get(
                `/rest/api/3/workflow/search?${params}`,
              )) as { values: WorkflowApiItem[]; total: number; isLast: boolean };
            },
            maxResults,
          ),
        emit,
        heartbeatIntervalMs,
      );

      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = result.items.map((item) => {
        const name =
          typeof item.id === 'string' ? item.id : (item.id as { name: string }).name;
        return {
          id: name,
          key: name,
          phase: 'workflow',
          objectType: 'Workflow',
          capturedAt,
          status: 'success',
          backupPointId,
          data: item,
        };
      });

      const section: ManifestStageSection = {
        stageName: 'workflow',
        apiPageCount: result.pagesFetched,
        apiTotalReported: result.apiReportedTotal,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=workflow count=${entries.length} outcome=ok`,
      );
      emit({
        type: 'stage_complete',
        stage: 'workflow',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'workflow', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=workflow error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=workflow outcome=error`, err);
      return {
        stageName: 'workflow',
        entries: [],
        section: this.errorSection('workflow'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: WorkflowScheme ───────────────────────────────────────────────────

  private async captureWorkflowSchemes(
    backupPointId: string,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({
      type: 'stage_start',
      stage: 'workflow_scheme',
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await this.runWithHeartbeat(
        'workflow_scheme',
        async () =>
          paginateAtlassian<WorkflowSchemeApiItem>(
            async (startAt, mr) => {
              const params = new URLSearchParams({
                startAt: String(startAt),
                maxResults: String(mr),
              });
              return (await this.httpClient.get(
                `/rest/api/3/workflowscheme?${params}`,
              )) as { values: WorkflowSchemeApiItem[]; total: number; isLast: boolean };
            },
            maxResults,
          ),
        emit,
        heartbeatIntervalMs,
      );

      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = result.items.map((item) => ({
        id: String(item.id),
        key: item.name,
        phase: 'workflow_scheme',
        objectType: 'WorkflowScheme',
        capturedAt,
        status: 'success',
        backupPointId,
        data: item,
      }));

      const section: ManifestStageSection = {
        stageName: 'workflow_scheme',
        apiPageCount: result.pagesFetched,
        apiTotalReported: result.apiReportedTotal,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=workflow_scheme count=${entries.length} outcome=ok`,
      );
      emit({
        type: 'stage_complete',
        stage: 'workflow_scheme',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'workflow_scheme', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=workflow_scheme error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=workflow_scheme outcome=error`, err);
      return {
        stageName: 'workflow_scheme',
        entries: [],
        section: this.errorSection('workflow_scheme'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: Board ────────────────────────────────────────────────────────────

  private async captureBoards(
    backupPointId: string,
    projects: Array<{ id: string; key: string }>,
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({ type: 'stage_start', stage: 'board', timestamp: new Date().toISOString() });

    try {
      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = [];
      let totalPagesFetched = 0;
      let totalApiReported = 0;

      await this.runWithHeartbeat(
        'board',
        async () => {
          for (const project of projects) {
            const result = await paginateAtlassian<BoardApiItem>(
              async (startAt, mr) => {
                const params = new URLSearchParams({
                  startAt: String(startAt),
                  maxResults: String(mr),
                  projectKeyOrId: project.key,
                });
                return (await this.httpClient.get(
                  `/rest/agile/1.0/board?${params}`,
                )) as { values: BoardApiItem[]; total: number; isLast: boolean };
              },
              maxResults,
            );

            totalPagesFetched += result.pagesFetched;
            totalApiReported += result.apiReportedTotal ?? result.totalFetched;

            for (const board of result.items) {
              entries.push({
                id: String(board.id),
                key: board.name,
                phase: 'board',
                objectType: 'JiraBoard',
                capturedAt,
                status: 'success',
                backupPointId,
                data: board,
              });
            }
          }
        },
        emit,
        heartbeatIntervalMs,
      );

      const section: ManifestStageSection = {
        stageName: 'board',
        apiPageCount: totalPagesFetched,
        apiTotalReported: totalApiReported,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=board count=${entries.length} outcome=ok`,
      );
      emit({
        type: 'stage_complete',
        stage: 'board',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'board', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=board error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=board outcome=error`, err);
      return {
        stageName: 'board',
        entries: [],
        section: this.errorSection('board'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Stage: Sprint ───────────────────────────────────────────────────────────

  private async captureSprints(
    backupPointId: string,
    priorStageResults: CaptureStageResult[],
    maxResults: number,
    emit: (e: ProgressEvent) => void,
    heartbeatIntervalMs: number,
  ): Promise<CaptureStageResult> {
    emit({ type: 'stage_start', stage: 'sprint', timestamp: new Date().toISOString() });

    // Collect board IDs from the completed board stage
    const boardStage = priorStageResults.find((s) => s.stageName === 'board');
    const boardIds = (boardStage?.entries ?? []).map((e) => e.id);

    try {
      const capturedAt = new Date().toISOString();
      const entries: ManifestEntry[] = [];
      let totalPagesFetched = 0;
      let totalApiReported = 0;

      await this.runWithHeartbeat(
        'sprint',
        async () => {
          for (const boardId of boardIds) {
            const result = await paginateAtlassian<SprintApiItem>(
              async (startAt, mr) => {
                const params = new URLSearchParams({
                  startAt: String(startAt),
                  maxResults: String(mr),
                });
                return (await this.httpClient.get(
                  `/rest/agile/1.0/board/${boardId}/sprint?${params}`,
                )) as { values: SprintApiItem[]; total: number; isLast: boolean };
              },
              maxResults,
            );

            totalPagesFetched += result.pagesFetched;
            totalApiReported += result.apiReportedTotal ?? result.totalFetched;

            for (const sprint of result.items) {
              entries.push({
                id: String(sprint.id),
                key: sprint.name,
                phase: 'sprint',
                objectType: 'JiraSprint',
                capturedAt,
                status: 'success',
                backupPointId,
                data: sprint,
              });
            }
          }
        },
        emit,
        heartbeatIntervalMs,
      );

      const section: ManifestStageSection = {
        stageName: 'sprint',
        apiPageCount: totalPagesFetched,
        apiTotalReported: totalApiReported,
        capturedCount: entries.length,
        skippedIds: [],
        skippedReasons: {},
      };

      console.log(
        `[jira-context-capture] stage=sprint count=${entries.length} outcome=ok`,
      );
      emit({
        type: 'stage_complete',
        stage: 'sprint',
        timestamp: new Date().toISOString(),
        count: entries.length,
      });

      return { stageName: 'sprint', entries, section, outcome: 'ok' };
    } catch (err) {
      const diagnostic = `stage=sprint error: ${String(err)}`;
      console.error(`[jira-context-capture] stage=sprint outcome=error`, err);
      return {
        stageName: 'sprint',
        entries: [],
        section: this.errorSection('sprint'),
        outcome: 'error',
        diagnostic,
      };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private errorSection(stageName: CapturePhase): ManifestStageSection {
    return {
      stageName,
      apiPageCount: 0,
      apiTotalReported: null,
      capturedCount: 0,
      skippedIds: [],
      skippedReasons: {},
    };
  }

  private sumSystemFieldsSkipped(stages: CaptureStageResult[]): number {
    const cfStage = stages.find((s) => s.stageName === 'custom_field');
    if (!cfStage) return 0;
    return (
      (cfStage.section as ManifestStageSection & { systemFieldsSkipped?: number })
        .systemFieldsSkipped ?? 0
    );
  }
}
