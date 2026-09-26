/**
 * SDIS diagnostic worklist (Step 21) — a read model over the authoritative
 * order repository. Deterministic operational queue ordering only:
 * priority rank (EMERGENCY -> URGENT -> ROUTINE), then ordered-at, then id.
 *
 * This is NOT clinical triage: it expresses no clinical judgement and no
 * critical-value policy. It exists so expedited work is distinguishable and
 * consistently ordered across facilities. Ordering rules are documented, not
 * learned or inferred.
 */

import type { DiagnosticOrderStatus } from '../../domain/ordering/diagnostic-order';
import { toOrderDTO, type OrderDTO } from '../dto';
import type { ApplicationSession } from '../context';
import { requireSession } from '../context';
import { assertSessionFacility } from '../context';
import type { FacilityDirectory } from '../ports';
import type { OrderRepository, SpecimenRepository } from '../ports';
import type { Permission } from '../authz/rbac';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { SetupConfigService } from '../setup/setup-config-service';
import type { QualityRecordRepository, QualityHold } from '../quality/quality-service';
import type { SpecimenStatus } from '../../domain/specimen/specimen';

export interface WorklistDependencies {
  readonly orders: OrderRepository;
  readonly facilities: FacilityDirectory;
  /**
   * Optional configuration (Step 24): `worklist.defaultPageSize` and
   * `worklist.includeHistory` bound the read model. Operational paging and
   * filtering ONLY — ordering (priority rank → ordered-at → id) is
   * deterministic and never configuration-dependent, and no clinical
   * semantic is touched. Absent config → documented defaults (50 / false).
   */
  readonly config?: SetupConfigService;
  /** Optional authorization engine — when present, ORDER_READ is enforced
   * exactly like every other order read path (no separate worklist
   * permission, no second permission system). */
  readonly authz?: AuthorizationService;
  /**
   * Optional specimen read model (Step 29): enables the specimen-backed
   * views (accessioning / processing / exception). Absent → those views
   * degrade to `null` (the plain order worklist stays fully functional).
   */
  readonly specimens?: SpecimenRepository;
  /**
   * Optional quality read model (Step 29): when present, the `exception`
   * view surfaces the facility's active analytical hold (Step 27 QC
   * boundary) alongside workflow exceptions.
   */
  readonly quality?: QualityRecordRepository;
  /** Monotonic clock seam for deterministic waiting-time derivation. */
  readonly now?: () => number;
}

/** One worklist entry: the canonical order DTO (nothing duplicated). */
export type WorklistEntry = OrderDTO;

/**
 * Step 29 — typed operational views over authoritative state. Each view is a
 * WHERE clause on the lifecycle, not a new status system: the referenced
 * states are exactly the canonical order/specimen states (Steps 27–28).
 */
export type WorklistView =
  | 'collection' // orders awaiting specimen collection (ACQUIRED, pre-collect)
  | 'accessioning' // collected specimens awaiting receipt/accession (COLLECTED)
  | 'processing' // accessioned specimens awaiting processing (RECEIVED)
  | 'result-entry' // orders in analysis awaiting results (PROCESSING)
  | 'verification' // entered results awaiting verification (RESULT_ENTERED)
  | 'finalization' // verified results awaiting finalization (VERIFIED)
  | 'exception'; // workflow exceptions (REJECTED specimens) + active QC hold

/** The specimen statuses each specimen-backed view selects. */
const VIEW_SPECIMEN_STATUSES: {
  readonly accessioning: readonly SpecimenStatus[];
  readonly processing: readonly SpecimenStatus[];
  readonly exception: readonly SpecimenStatus[];
} = {
  accessioning: ['COLLECTED'],
  processing: ['RECEIVED'],
  exception: ['REJECTED'],
};

/** The order statuses each order-backed view selects. */
const VIEW_ORDER_STATUSES: {
  readonly collection: readonly DiagnosticOrderStatus[];
  readonly 'result-entry': readonly DiagnosticOrderStatus[];
  readonly verification: readonly DiagnosticOrderStatus[];
  readonly finalization: readonly DiagnosticOrderStatus[];
  readonly exception: readonly DiagnosticOrderStatus[];
} = {
  collection: ['ACQUIRED'],
  'result-entry': ['PROCESSING'],
  verification: ['RESULT_ENTERED'],
  finalization: ['VERIFIED'],
  exception: ['CANCELLED'],
};

/**
 * View → permission: reuses the EXISTING permission matrix (no second RBAC
 * system). Each view demands the permission of the WORK it leads to, so the
 * role-aware mapping below falls out of the established role tiers:
 * viewer < operator (collect/acccession/process/enter) ≤ manager (verify/
 * finalize/exception oversight hold QUALITY_MANAGE — never a configuration
 * permission for clinical oversight, AUD-02).
 */
const VIEW_PERMISSIONS: Readonly<Record<WorklistView, Permission>> = {
  collection: PERMISSIONS.SPECIMEN_CREATE,
  accessioning: PERMISSIONS.SPECIMEN_CREATE,
  processing: PERMISSIONS.SPECIMEN_CREATE,
  'result-entry': PERMISSIONS.OBSERVATION_CREATE,
  verification: PERMISSIONS.QUALITY_MANAGE,
  finalization: PERMISSIONS.REPORT_CREATE,
  exception: PERMISSIONS.QUALITY_MANAGE,
};

/**
 * Stable operational representation of one specimen-backed work item
 * (Step 29 §4): references and workflow metadata only — NO patient-identifying
 * content beyond the workflow-required specimen context, no result values, no
 * internal database shapes.
 */
export interface SpecimenWorkItem {
  readonly kind: 'specimen';
  readonly specimenId: string;
  readonly orderItemId: string;
  readonly accessionNumber?: string;
  readonly specimenKind: string;
  readonly status: SpecimenStatus;
  readonly rejectionReason?: string;
  readonly collectedAt: string;
  /** Waiting duration in ms, deterministically derived (now - collectedAt). */
  readonly waitingMs: number;
}

/**
 * Step 29 worklist page: bounded, deterministic, cursor-ready. `nextCursor`
 * is the LAST item's sort key — pass it as `filters.cursor` to resume AFTER
 * that item (stable across concurrent inserts at the same key because the
 * tie-break is the unique id).
 */
export interface WorklistPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Read-model filters (Step 27): operational narrowing of the authoritative
 * facility worklist. Filters never widen scope (facility stays server-derived)
 * and never change ordering semantics. `status` narrows to one lifecycle
 * state; `priority` to one priority; `from`/`to` bound `orderedAt`.
 */
export interface WorklistFilters {
  readonly status?: DiagnosticOrderStatus;
  readonly priority?: 'ROUTINE' | 'URGENT' | 'EMERGENCY';
  readonly from?: string;
  readonly to?: string;
  /** Step 29: narrow to one test code (order-backed views). */
  readonly testCode?: string;
  /** Step 29: resume after this sort key (keyset pagination). */
  readonly cursor?: string;
  /** Step 29: page bound override (≤ configured maximum). */
  readonly limit?: number;
}

export class WorklistService {
  constructor(private readonly deps: WorklistDependencies) {}

  /**
   * The caller's facility worklist, deterministically ordered. Scope is
   * server-derived from the session (never accepted from the client) and the
   * session's facility is validated against the directory first.
   */
  async listForSession(
    session: ApplicationSession | undefined,
    filters: WorklistFilters = {},
  ): Promise<readonly WorklistEntry[]> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    // Same read permission as every other order read path (no separate
    // worklist permission — fail-closed, no second permission system).
    await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_READ);
    const orders = await this.deps.orders.listByFacilityWithPriority(session.facilityId);
    const settings = await this.resolveSettings(session);
    let visible = settings.includeHistory
      ? orders
      : orders.filter((order) => order.status !== 'REPORTED');
    // Step 27 filters: pure narrowing of the SAME authoritative read model.
    if (filters.status !== undefined) {
      visible = visible.filter((order) => order.status === filters.status);
    }
    if (filters.priority !== undefined) {
      visible = visible.filter((order) => order.priority === filters.priority);
    }
    if (filters.from !== undefined) {
      const from = new Date(filters.from).getTime();
      if (!Number.isNaN(from)) {
        visible = visible.filter((order) => new Date(order.orderedAt).getTime() >= from);
      }
    }
    if (filters.to !== undefined) {
      const to = new Date(filters.to).getTime();
      if (!Number.isNaN(to)) {
        visible = visible.filter((order) => new Date(order.orderedAt).getTime() <= to);
      }
    }
    return visible.slice(0, settings.pageSize).map(toOrderDTO);
  }

  /**
   * Step 29 — typed operational views. Each view is a parameterization of the
   * SAME authoritative read model: no second state store, no workflow states
   * beyond the canonical lifecycle. Scope + view permission are enforced
   * server-side (fail-closed); ordering is deterministic (priority rank →
   * ordered-at → id for order views; collected-at → id for specimen views).
   * Results are bounded (keyset pagination via `filters.cursor` + `limit`).
   */
  async listView(
    session: ApplicationSession | undefined,
    view: WorklistView,
    filters: WorklistFilters = {},
  ): Promise<WorklistPage<WorklistEntry | SpecimenWorkItem> & { hold?: QualityHold }> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    await this.deps.authz?.assertPermission(session, VIEW_PERMISSIONS[view]);
    const settings = await this.resolveSettings(session);
    const limit = Math.min(
      Math.max(1, filters.limit ?? settings.pageSize),
      settings.pageSize,
    );
    const now = this.deps.now ?? Date.now;

    const orderPage = async (
      statuses: readonly DiagnosticOrderStatus[],
    ): Promise<WorklistPage<WorklistEntry>> => {
      let orders = await this.deps.orders.listByFacilityWithPriority(session!.facilityId);
      orders = orders.filter((order) => statuses.includes(order.status));
      if (filters.priority !== undefined) {
        orders = orders.filter((o) => o.priority === filters.priority);
      }
      if (filters.testCode !== undefined) {
        orders = orders.filter((o) =>
          o.items.some((item) => item.testCode === filters.testCode),
        );
      }
      if (filters.from !== undefined) {
        const from = new Date(filters.from).getTime();
        if (!Number.isNaN(from)) {
          orders = orders.filter((o) => new Date(o.orderedAt).getTime() >= from);
        }
      }
      if (filters.to !== undefined) {
        const to = new Date(filters.to).getTime();
        if (!Number.isNaN(to)) {
          orders = orders.filter((o) => new Date(o.orderedAt).getTime() <= to);
        }
      }
      if (filters.cursor !== undefined) {
        // Keyset resume: strictly after the cursor key (orderedAt + id).
        const [cursorAt, cursorId] = splitCursor(filters.cursor);
        orders = orders.filter(
          (o) =>
            o.orderedAt > cursorAt ||
            (o.orderedAt === cursorAt && String(o.id) > cursorId),
        );
      }
      const window = orders.slice(0, limit + 1);
      const items = window.slice(0, limit).map(toOrderDTO);
      // Lookahead: a cursor is advertised only when more rows exist past
      // this page (API-01) — a full final page ends with a null cursor
      // instead of one extra empty fetch.
      const last = window.length > limit ? window[limit - 1] : undefined;
      return {
        items,
        nextCursor: last ? `${last.orderedAt}|${String(last.id)}` : null,
      };
    };

    const specimenPage = async (
      statuses: readonly SpecimenStatus[],
    ): Promise<WorklistPage<SpecimenWorkItem>> => {
      if (!this.deps.specimens) return { items: [], nextCursor: null };
      let specimens = await this.deps.specimens.listByFacilityWithStatus(
        session!.facilityId,
        statuses,
      );
      if (filters.cursor !== undefined) {
        const [cursorAt, cursorId] = splitCursor(filters.cursor);
        specimens = specimens.filter(
          (s) =>
            s.collectedAt > cursorAt ||
            (s.collectedAt === cursorAt && String(s.id) > cursorId),
        );
      }
      const window = specimens.slice(0, limit + 1);
      const items = window.slice(0, limit).map((s) => ({
        kind: 'specimen' as const,
        specimenId: String(s.id),
        orderItemId: String(s.orderItemId),
        ...(s.accessionNumber ? { accessionNumber: s.accessionNumber } : {}),
        specimenKind: s.kind,
        status: s.status,
        ...(s.rejectionReason ? { rejectionReason: s.rejectionReason } : {}),
        collectedAt: s.collectedAt,
        waitingMs: Math.max(0, now() - Date.parse(s.collectedAt)),
      }));
      const last = window.length > limit ? window[limit - 1] : undefined;
      return {
        items,
        nextCursor: last ? `${last.collectedAt}|${String(last.id)}` : null,
      };
    };

    switch (view) {
      case 'collection':
      case 'result-entry':
      case 'verification':
      case 'finalization':
        return orderPage(VIEW_ORDER_STATUSES[view]);
      case 'accessioning':
      case 'processing':
        return specimenPage(VIEW_SPECIMEN_STATUSES[view]);
      case 'exception': {
        // Workflow exceptions first (rejected specimens; cancelled orders),
        // then the facility's active QC hold, if any (Step 27 boundary —
        // surfaced for authorized oversight, never overridden by the
        // worklist and never conflated with patient result state).
        const rejected = await specimenPage(VIEW_SPECIMEN_STATUSES.exception);
        const cancelled = await orderPage(VIEW_ORDER_STATUSES.exception);
        const hold = this.deps.quality
          ? await this.deps.quality.findActiveHold(session!.facilityId)
          : undefined;
        return {
          items: [...rejected.items, ...cancelled.items],
          nextCursor: cancelled.nextCursor,
          ...(hold ? { hold } : {}),
        };
      }
    }
  }

  /**
   * Resolves the bounded worklist settings from the Step-24 configuration
   * registry (facility scope, validated at write time). Missing config →
   * the documented defaults (50 / false) — identical to pre-Step-24 behavior.
   */
  private async resolveSettings(
    session: ApplicationSession,
  ): Promise<{ readonly pageSize: number; readonly includeHistory: boolean }> {
    const defaults = { pageSize: 50, includeHistory: false };
    if (!this.deps.config) return defaults;
    try {
      const pageSize = await this.deps.config.getConfig(session, {
        family: 'FACILITY' as const,
        key: 'worklist.defaultPageSize',
      });
      const value = pageSize.value;
      return {
        ...defaults,
        ...(typeof value === 'number' && Number.isInteger(value)
          ? { pageSize: value }
          : {}),
      };
    } catch {
      // Unset configuration is the DEFAULT case — never an error condition.
      return defaults;
    }
  }
}

/** Splits an opaque `orderedAt|id` cursor into its two sort keys. */
function splitCursor(cursor: string): readonly [string, string] {
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0) return ['', cursor];
  return [cursor.slice(0, separator), cursor.slice(separator + 1)];
}
