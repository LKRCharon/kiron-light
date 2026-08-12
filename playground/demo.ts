/**
 * Kiron Fleet Control Plane playground.
 *
 * This single-file reference models a multi-tenant progressive delivery system.
 * It is deliberately dependency-free so VS Code can provide complete semantic
 * highlighting with only the built-in TypeScript language service.
 */

export type Environment = "development" | "staging" | "production";
export type TenantTier = "starter" | "growth" | "enterprise";
export type ReleaseState =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "succeeded"
  | "rolling_back"
  | "rolled_back"
  | "failed";
export type StageKind = "canary" | "regional" | "global";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "open" | "acknowledged" | "resolved";
export type FlagValue = boolean | string | number;
export type AuditAction =
  | "release.created"
  | "release.started"
  | "release.stage_promoted"
  | "release.paused"
  | "release.rolled_back"
  | "flag.changed"
  | "alert.opened"
  | "alert.acknowledged"
  | "alert.resolved";

const DEFAULT_CANARY_PERCENT = 5;
const MAX_AUDIT_PAGE_SIZE = 200;
const CONTROL_PLANE_SEED = "kiron-fleet-control-plane-v1";

export class FleetError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends FleetError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("validation_error", message, details);
  }
}

export class NotFoundError extends FleetError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("not_found", message, details);
  }
}

export class ConflictError extends FleetError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("conflict", message, details);
  }
}

export class PolicyViolationError extends FleetError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("policy_violation", message, details);
  }
}

export class AdapterError extends FleetError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("adapter_error", message, details);
  }
}

export function requireSlug(value: string, fieldName: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError(fieldName + " cannot be empty");
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
    throw new ValidationError(
      fieldName + " contains unsupported characters",
      { value },
    );
  }
  return normalized;
}

export function requirePercentage(
  value: number,
  fieldName: string,
): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ValidationError(
      fieldName + " must be an integer between 0 and 100",
      { value },
    );
  }
  return value;
}

export function requirePositive(
  value: number,
  fieldName: string,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(
      fieldName + " must be a positive finite number",
      { value },
    );
  }
  return value;
}

export function parseSemver(version: string): readonly [
  number,
  number,
  number,
] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new ValidationError(
      "artifact version must use major.minor.patch",
      { version },
    );
  }
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
}

export function stableId(kind: string, ...parts: readonly string[]): string {
  let hash = 2_166_136_261;
  const payload = [CONTROL_PLANE_SEED, kind, ...parts].join(":");
  for (const character of payload) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return kind + "_" + (hash >>> 0).toString(16).padStart(8, "0");
}

export function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

export function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

export interface TenantPolicy {
  readonly id: string;
  readonly displayName: string;
  readonly tier: TenantTier;
  readonly allowedRegions: readonly string[];
  readonly productionApprovers: number;
  readonly maxCanaryPercent: number;
  readonly minimumSloTarget: number;
  readonly freezeWindowsUtc: readonly (readonly [number, number])[];
}

export interface ServiceTarget {
  readonly service: string;
  readonly environment: Environment;
  readonly regions: readonly string[];
  readonly desiredReplicas: number;
}

export interface Artifact {
  readonly digest: string;
  readonly version: string;
  readonly sourceRevision: string;
  readonly createdAt: Date;
  readonly sbomReference: string;
}

export interface RolloutStage {
  readonly name: string;
  readonly kind: StageKind;
  readonly trafficPercent: number;
  readonly regions: readonly string[];
  readonly minimumObservationMinutes: number;
  readonly requiredHealthyChecks: number;
}

export interface ReleasePlan {
  readonly id: string;
  readonly tenantId: string;
  readonly target: ServiceTarget;
  readonly artifact: Artifact;
  readonly stages: readonly RolloutStage[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly approvals: readonly string[];
}

export interface Deployment {
  readonly id: string;
  readonly plan: ReleasePlan;
  readonly state: ReleaseState;
  readonly currentStageIndex: number;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly rollbackReason?: string;
  readonly baselineVersion?: string;
  readonly revision: number;
}

export interface FlagRule {
  readonly id: string;
  readonly description: string;
  readonly percentage: number;
  readonly regions: readonly string[];
  readonly tenantTiers: readonly TenantTier[];
  readonly attributes: Readonly<Record<string, string>>;
}

export interface FeatureFlag {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly enabled: boolean;
  readonly defaultValue: FlagValue;
  readonly rules: readonly FlagRule[];
  readonly version: number;
  readonly updatedAt: Date;
}

export interface FlagContext {
  readonly subjectId: string;
  readonly region: string;
  readonly tenantTier: TenantTier;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface FlagDecision {
  readonly key: string;
  readonly value: FlagValue;
  readonly matchedRule?: string;
  readonly reason: "flag_disabled" | "rule_match" | "default";
}

export interface SloDefinition {
  readonly service: string;
  readonly environment: Environment;
  readonly availabilityTarget: number;
  readonly latencyP95Ms: number;
  readonly windowMinutes: number;
}

export interface MetricSnapshot {
  readonly service: string;
  readonly environment: Environment;
  readonly region: string;
  readonly sampledAt: Date;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly latencyP95Ms: number;
}

export interface SloAssessment {
  readonly definition: SloDefinition;
  readonly snapshots: readonly MetricSnapshot[];
  readonly availability: number;
  readonly worstLatencyP95Ms: number;
  readonly errorBudgetRemaining: number;
  readonly healthy: boolean;
  readonly reasons: readonly string[];
}

export interface Alert {
  readonly id: string;
  readonly tenantId: string;
  readonly service: string;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
  readonly summary: string;
  readonly deduplicationKey: string;
  readonly openedAt: Date;
  readonly acknowledgedBy?: string;
  readonly resolvedAt?: Date;
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly occurredAt: Date;
  readonly metadata: Readonly<Record<string, string>>;
  readonly correlationId: string;
}

export interface TraceRecord {
  readonly traceId: string;
  readonly operation: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly attributes: Readonly<Record<string, string>>;
  readonly errorCode?: string;
}

export interface ReleaseRequest {
  readonly tenantId: string;
  readonly service: string;
  readonly environment: Environment;
  readonly regions: readonly string[];
  readonly artifact: Artifact;
  readonly requestedBy: string;
  readonly approvers: readonly string[];
  readonly desiredReplicas: number;
  readonly canaryPercent: number;
}

export interface PromotionDecision {
  readonly allowed: boolean;
  readonly reason: "deployment_not_running" | "slo_gate_failed" | "slo_gate_passed";
  readonly assessment?: SloAssessment;
}

export interface Clock {
  now(): Date;
}

export interface RuntimeAdapter {
  deploy(
    deployment: Deployment,
    stage: RolloutStage,
  ): Promise<void>;

  rollback(
    deployment: Deployment,
    baselineVersion: string,
  ): Promise<void>;
}

export interface NotificationAdapter {
  send(
    channel: string,
    subject: string,
    body: string,
  ): Promise<void>;
}

export interface MetricsAdapter {
  snapshots(
    service: string,
    environment: Environment,
    regions: readonly string[],
    since: Date,
  ): Promise<readonly MetricSnapshot[]>;
}

export function validateTenantPolicy(policy: TenantPolicy): TenantPolicy {
  requireSlug(policy.id, "tenant.id");
  if (!policy.displayName.trim()) {
    throw new ValidationError("tenant displayName cannot be empty");
  }
  if (policy.allowedRegions.length === 0) {
    throw new ValidationError("tenant requires at least one region");
  }
  if (new Set(policy.allowedRegions).size !== policy.allowedRegions.length) {
    throw new ValidationError("tenant regions must be unique");
  }
  if (policy.productionApprovers < 1) {
    throw new ValidationError(
      "productionApprovers must be at least one",
    );
  }
  requirePercentage(policy.maxCanaryPercent, "maxCanaryPercent");
  if (
    policy.minimumSloTarget < 90
    || policy.minimumSloTarget > 100
  ) {
    throw new ValidationError(
      "minimumSloTarget must be between 90 and 100",
    );
  }
  for (const [startHour, endHour] of policy.freezeWindowsUtc) {
    if (
      startHour < 0
      || startHour > 23
      || endHour < 0
      || endHour > 23
    ) {
      throw new ValidationError("freeze window hours are invalid");
    }
  }
  return policy;
}

export function validateArtifact(artifact: Artifact): Artifact {
  if (
    !artifact.digest.startsWith("sha256:")
    || artifact.digest.length < 24
  ) {
    throw new ValidationError(
      "artifact digest must be a sha256 reference",
    );
  }
  parseSemver(artifact.version);
  if (artifact.sourceRevision.length < 7) {
    throw new ValidationError("source revision is too short");
  }
  if (!artifact.sbomReference.startsWith("sbom://")) {
    throw new ValidationError("SBOM reference must use sbom://");
  }
  return artifact;
}

export function validateStage(stage: RolloutStage): RolloutStage {
  requireSlug(stage.name, "stage.name");
  requirePercentage(stage.trafficPercent, "stage.trafficPercent");
  if (stage.regions.length === 0) {
    throw new ValidationError("stage requires at least one region");
  }
  if (stage.minimumObservationMinutes < 1) {
    throw new ValidationError(
      "minimum observation must be at least one minute",
    );
  }
  if (stage.requiredHealthyChecks < 1) {
    throw new ValidationError(
      "required healthy checks must be positive",
    );
  }
  return stage;
}

export function validateReleasePlan(plan: ReleasePlan): ReleasePlan {
  if (plan.stages.length === 0) {
    throw new ValidationError("release plan requires stages");
  }
  let previousPercent = -1;
  const names = new Set<string>();
  for (const stage of plan.stages) {
    validateStage(stage);
    if (stage.trafficPercent < previousPercent) {
      throw new ValidationError(
        "rollout stage traffic must increase monotonically",
      );
    }
    if (names.has(stage.name)) {
      throw new ValidationError("rollout stage names must be unique");
    }
    previousPercent = stage.trafficPercent;
    names.add(stage.name);
  }
  if (plan.stages.at(-1)?.trafficPercent !== 100) {
    throw new ValidationError(
      "final rollout stage must receive all traffic",
    );
  }
  return plan;
}

export function currentStage(deployment: Deployment): RolloutStage {
  const stage = deployment.plan.stages[deployment.currentStageIndex];
  if (!stage) {
    throw new ValidationError(
      "deployment current stage index is invalid",
      {
        deploymentId: deployment.id,
        currentStageIndex: deployment.currentStageIndex,
      },
    );
  }
  return stage;
}

export function isTerminalState(state: ReleaseState): boolean {
  return (
    state === "succeeded"
    || state === "rolled_back"
    || state === "failed"
  );
}

export function isFrozen(policy: TenantPolicy, moment: Date): boolean {
  const hour = moment.getUTCHours();
  return policy.freezeWindowsUtc.some(([start, end]) => {
    if (start < end) {
      return start <= hour && hour < end;
    }
    return hour >= start || hour < end;
  });
}

export class FrozenClock implements Clock {
  private current: Date;

  constructor(moment: Date) {
    this.current = copyDate(moment);
  }

  now(): Date {
    return copyDate(this.current);
  }

  advanceMinutes(minutes: number): void {
    this.current = addMinutes(this.current, minutes);
  }
}

export class TenantRepository {
  private readonly records = new Map<string, TenantPolicy>();

  constructor(initial: readonly TenantPolicy[] = []) {
    for (const policy of initial) {
      this.save(policy);
    }
  }

  get(tenantId: string): TenantPolicy {
    const record = this.records.get(tenantId);
    if (!record) {
      throw new NotFoundError(
        "tenant policy not found",
        { tenantId },
      );
    }
    return record;
  }

  save(policy: TenantPolicy): TenantPolicy {
    const validated = validateTenantPolicy(policy);
    this.records.set(validated.id, validated);
    return validated;
  }

  list(): readonly TenantPolicy[] {
    return [...this.records.values()]
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export class DeploymentRepository {
  private readonly records = new Map<string, Deployment>();

  get(deploymentId: string): Deployment {
    const record = this.records.get(deploymentId);
    if (!record) {
      throw new NotFoundError(
        "deployment not found",
        { deploymentId },
      );
    }
    return record;
  }

  save(
    deployment: Deployment,
    expectedRevision?: number,
  ): Deployment {
    const current = this.records.get(deployment.id);
    const actualRevision = current?.revision ?? 0;
    if (
      expectedRevision !== undefined
      && expectedRevision !== actualRevision
    ) {
      throw new ConflictError(
        "deployment revision changed",
        {
          deploymentId: deployment.id,
          expectedRevision,
          actualRevision,
        },
      );
    }
    const stored: Deployment = {
      ...deployment,
      revision: actualRevision + 1,
    };
    this.records.set(stored.id, stored);
    return stored;
  }

  listForTenant(tenantId: string): readonly Deployment[] {
    return [...this.records.values()]
      .filter((deployment) => deployment.plan.tenantId === tenantId);
  }
}

export class FlagRepository {
  private readonly records = new Map<string, FeatureFlag>();

  constructor(initial: readonly FeatureFlag[] = []) {
    for (const flag of initial) {
      this.records.set(this.key(flag.tenantId, flag.key), flag);
    }
  }

  private key(tenantId: string, flagKey: string): string {
    return tenantId + ":" + flagKey;
  }

  get(tenantId: string, flagKey: string): FeatureFlag {
    const record = this.records.get(this.key(tenantId, flagKey));
    if (!record) {
      throw new NotFoundError(
        "feature flag not found",
        { tenantId, flagKey },
      );
    }
    return record;
  }

  save(
    flag: FeatureFlag,
    expectedVersion?: number,
  ): FeatureFlag {
    const lookupKey = this.key(flag.tenantId, flag.key);
    const current = this.records.get(lookupKey);
    const actualVersion = current?.version ?? 0;
    if (
      expectedVersion !== undefined
      && expectedVersion !== actualVersion
    ) {
      throw new ConflictError(
        "feature flag version changed",
        {
          expectedVersion,
          actualVersion,
        },
      );
    }
    this.records.set(lookupKey, flag);
    return flag;
  }
}

export class AlertRepository {
  private readonly records = new Map<string, Alert>();
  private readonly openByDeduplicationKey = new Map<string, string>();

  get(alertId: string): Alert {
    const record = this.records.get(alertId);
    if (!record) {
      throw new NotFoundError("alert not found", { alertId });
    }
    return record;
  }

  save(alert: Alert): Alert {
    this.records.set(alert.id, alert);
    if (alert.state === "resolved") {
      this.openByDeduplicationKey.delete(alert.deduplicationKey);
    } else {
      this.openByDeduplicationKey.set(
        alert.deduplicationKey,
        alert.id,
      );
    }
    return alert;
  }

  findOpen(deduplicationKey: string): Alert | undefined {
    const alertId = this.openByDeduplicationKey.get(
      deduplicationKey,
    );
    return alertId ? this.records.get(alertId) : undefined;
  }
}

export class AuditRepository {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(event);
  }

  query(
    tenantId: string,
    options: {
      readonly action?: AuditAction;
      readonly limit?: number;
    } = {},
  ): readonly AuditEvent[] {
    const safeLimit = Math.min(
      Math.max(options.limit ?? 50, 1),
      MAX_AUDIT_PAGE_SIZE,
    );
    return this.events
      .filter((event) => {
        return (
          event.tenantId === tenantId
          && (!options.action || event.action === options.action)
        );
      })
      .reverse()
      .slice(0, safeLimit);
  }
}

export class RecordingRuntimeAdapter implements RuntimeAdapter {
  readonly deployments: Array<{
    readonly deploymentId: string;
    readonly stage: string;
    readonly trafficPercent: number;
  }> = [];

  readonly rollbacks: Array<{
    readonly deploymentId: string;
    readonly baselineVersion: string;
  }> = [];

  failNextOperation = false;

  async deploy(
    deployment: Deployment,
    stage: RolloutStage,
  ): Promise<void> {
    if (this.failNextOperation) {
      this.failNextOperation = false;
      throw new AdapterError("runtime rejected deployment");
    }
    this.deployments.push({
      deploymentId: deployment.id,
      stage: stage.name,
      trafficPercent: stage.trafficPercent,
    });
  }

  async rollback(
    deployment: Deployment,
    baselineVersion: string,
  ): Promise<void> {
    if (this.failNextOperation) {
      this.failNextOperation = false;
      throw new AdapterError("runtime rejected rollback");
    }
    this.rollbacks.push({
      deploymentId: deployment.id,
      baselineVersion,
    });
  }
}

export class RecordingNotificationAdapter implements NotificationAdapter {
  readonly messages: Array<{
    readonly channel: string;
    readonly subject: string;
    readonly body: string;
  }> = [];

  async send(
    channel: string,
    subject: string,
    body: string,
  ): Promise<void> {
    this.messages.push({ channel, subject, body });
  }
}

export class FixtureMetricsAdapter implements MetricsAdapter {
  private records: readonly MetricSnapshot[];

  constructor(initial: readonly MetricSnapshot[] = []) {
    this.records = initial;
  }

  replace(records: readonly MetricSnapshot[]): void {
    this.records = records;
  }

  async snapshots(
    service: string,
    environment: Environment,
    regions: readonly string[],
    since: Date,
  ): Promise<readonly MetricSnapshot[]> {
    const regionSet = new Set(regions);
    return this.records.filter((snapshot) => {
      return (
        snapshot.service === service
        && snapshot.environment === environment
        && regionSet.has(snapshot.region)
        && snapshot.sampledAt.getTime() >= since.getTime()
      );
    });
  }
}

export class CounterRegistry {
  private readonly values = new Map<string, number>();

  private serialize(
    name: string,
    labels: Readonly<Record<string, string>>,
  ): string {
    const suffix = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => key + "=" + value)
      .join(",");
    return suffix ? name + "{" + suffix + "}" : name;
  }

  increment(
    name: string,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    const key = this.serialize(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  value(
    name: string,
    labels: Readonly<Record<string, string>> = {},
  ): number {
    return this.values.get(this.serialize(name, labels)) ?? 0;
  }

  exportLines(): readonly string[] {
    return [...this.values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => key + " " + value);
  }
}

export class TraceCollector {
  readonly records: TraceRecord[] = [];

  constructor(private readonly clock: Clock) {}

  async trace<T>(
    operation: string,
    attributes: Readonly<Record<string, string>>,
    callback: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.clock.now();
    const traceId = stableId(
      "trace",
      operation,
      String(this.records.length),
    );
    try {
      const value = await callback();
      this.records.push({
        traceId,
        operation,
        startedAt,
        finishedAt: this.clock.now(),
        attributes,
      });
      return value;
    } catch (error) {
      this.records.push({
        traceId,
        operation,
        startedAt,
        finishedAt: this.clock.now(),
        attributes,
        errorCode: error instanceof FleetError
          ? error.code
          : "unexpected_error",
      });
      throw error;
    }
  }
}

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock,
  ) {}

  record(
    tenantId: string,
    actor: string,
    action: AuditAction,
    targetType: string,
    targetId: string,
    metadata: Readonly<Record<string, string>>,
    correlationId: string,
  ): AuditEvent {
    const occurredAt = this.clock.now();
    const event: AuditEvent = {
      id: stableId(
        "audit",
        tenantId,
        action,
        targetId,
        occurredAt.toISOString(),
      ),
      tenantId,
      actor,
      action,
      targetType,
      targetId,
      occurredAt,
      metadata,
      correlationId,
    };
    this.repository.append(event);
    return event;
  }
}

export function flagBucket(
  tenantId: string,
  flagKey: string,
  subjectId: string,
): number {
  let hash = 0;
  const payload = tenantId + ":" + flagKey + ":" + subjectId;
  for (const character of payload) {
    hash = Math.imul(hash, 31) + (character.codePointAt(0) ?? 0);
  }
  return Math.abs(hash) % 100;
}

export class FeatureFlagService {
  constructor(
    private readonly repository: FlagRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  evaluate(
    tenantId: string,
    flagKey: string,
    context: FlagContext,
  ): FlagDecision {
    const flag = this.repository.get(tenantId, flagKey);
    if (!flag.enabled) {
      return {
        key: flag.key,
        value: flag.defaultValue,
        reason: "flag_disabled",
      };
    }
    const bucket = flagBucket(
      tenantId,
      flagKey,
      context.subjectId,
    );
    for (const rule of flag.rules) {
      if (
        rule.regions.length > 0
        && !rule.regions.includes(context.region)
      ) {
        continue;
      }
      if (
        rule.tenantTiers.length > 0
        && !rule.tenantTiers.includes(context.tenantTier)
      ) {
        continue;
      }
      const attributesMatch = Object.entries(rule.attributes)
        .every(([key, value]) => context.attributes[key] === value);
      if (!attributesMatch) {
        continue;
      }
      if (bucket < rule.percentage) {
        return {
          key: flag.key,
          value: true,
          matchedRule: rule.id,
          reason: "rule_match",
        };
      }
    }
    return {
      key: flag.key,
      value: flag.defaultValue,
      reason: "default",
    };
  }

  update(
    tenantId: string,
    flagKey: string,
    actor: string,
    change: {
      readonly enabled: boolean;
      readonly rules: readonly FlagRule[];
      readonly expectedVersion: number;
      readonly correlationId: string;
    },
  ): FeatureFlag {
    const current = this.repository.get(tenantId, flagKey);
    const updated: FeatureFlag = {
      ...current,
      enabled: change.enabled,
      rules: change.rules,
      version: current.version + 1,
      updatedAt: this.clock.now(),
    };
    const saved = this.repository.save(
      updated,
      change.expectedVersion,
    );
    this.audit.record(
      tenantId,
      actor,
      "flag.changed",
      "feature_flag",
      flagKey,
      {
        enabled: String(saved.enabled),
        version: String(saved.version),
      },
      change.correlationId,
    );
    return saved;
  }
}

export class SloService {
  constructor(
    private readonly metrics: MetricsAdapter,
    private readonly clock: Clock,
  ) {}

  async assess(
    definition: SloDefinition,
    regions: readonly string[],
  ): Promise<SloAssessment> {
    const since = addMinutes(
      this.clock.now(),
      -definition.windowMinutes,
    );
    const snapshots = await this.metrics.snapshots(
      definition.service,
      definition.environment,
      regions,
      since,
    );
    if (snapshots.length === 0) {
      return {
        definition,
        snapshots: [],
        availability: 0,
        worstLatencyP95Ms: Number.POSITIVE_INFINITY,
        errorBudgetRemaining: 0,
        healthy: false,
        reasons: ["missing_metrics"],
      };
    }
    const totalRequests = snapshots.reduce(
      (total, item) => total + item.requestCount,
      0,
    );
    const totalErrors = snapshots.reduce(
      (total, item) => total + item.errorCount,
      0,
    );
    const availability = totalRequests === 0
      ? 100
      : 100 * (totalRequests - totalErrors) / totalRequests;
    const worstLatencyP95Ms = Math.max(
      ...snapshots.map((item) => item.latencyP95Ms),
    );
    const permittedFailure = Math.max(
      100 - definition.availabilityTarget,
      0.0001,
    );
    const actualFailure = 100 - availability;
    const errorBudgetRemaining = Math.max(
      0,
      100 * (1 - actualFailure / permittedFailure),
    );
    const reasons: string[] = [];
    if (availability < definition.availabilityTarget) {
      reasons.push("availability_below_target");
    }
    if (worstLatencyP95Ms > definition.latencyP95Ms) {
      reasons.push("latency_above_target");
    }
    return {
      definition,
      snapshots,
      availability,
      worstLatencyP95Ms,
      errorBudgetRemaining,
      healthy: reasons.length === 0,
      reasons,
    };
  }
}

export class AlertService {
  constructor(
    private readonly repository: AlertRepository,
    private readonly notifications: NotificationAdapter,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async openForAssessment(
    tenantId: string,
    assessment: SloAssessment,
    correlationId: string,
  ): Promise<Alert | undefined> {
    if (assessment.healthy) {
      return undefined;
    }
    const service = assessment.definition.service;
    const severity: AlertSeverity =
      assessment.errorBudgetRemaining <= 10
        ? "critical"
        : "warning";
    const deduplicationKey = [
      tenantId,
      service,
      assessment.definition.environment,
      "slo",
    ].join(":");
    const existing = this.repository.findOpen(deduplicationKey);
    if (existing) {
      return existing;
    }
    const summary = service
      + " violates SLO: "
      + assessment.reasons.join(", ");
    const openedAt = this.clock.now();
    const alert: Alert = {
      id: stableId(
        "alert",
        deduplicationKey,
        openedAt.toISOString(),
      ),
      tenantId,
      service,
      severity,
      state: "open",
      summary,
      deduplicationKey,
      openedAt,
    };
    this.repository.save(alert);
    await this.notifications.send(
      "fleet-oncall",
      "[" + severity + "] " + service,
      summary,
    );
    this.audit.record(
      tenantId,
      "system:slo-evaluator",
      "alert.opened",
      "alert",
      alert.id,
      { severity },
      correlationId,
    );
    return alert;
  }

  acknowledge(
    alertId: string,
    actor: string,
    correlationId: string,
  ): Alert {
    const current = this.repository.get(alertId);
    if (current.state === "resolved") {
      throw new ConflictError(
        "resolved alert cannot be acknowledged",
      );
    }
    const updated: Alert = {
      ...current,
      state: "acknowledged",
      acknowledgedBy: actor,
    };
    this.repository.save(updated);
    this.audit.record(
      current.tenantId,
      actor,
      "alert.acknowledged",
      "alert",
      current.id,
      {},
      correlationId,
    );
    return updated;
  }

  resolve(
    alertId: string,
    actor: string,
    correlationId: string,
  ): Alert {
    const current = this.repository.get(alertId);
    const updated: Alert = {
      ...current,
      state: "resolved",
      resolvedAt: this.clock.now(),
    };
    this.repository.save(updated);
    this.audit.record(
      current.tenantId,
      actor,
      "alert.resolved",
      "alert",
      current.id,
      {},
      correlationId,
    );
    return updated;
  }
}

export class ReleasePlanner {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly clock: Clock,
  ) {}

  create(request: ReleaseRequest): ReleasePlan {
    const policy = this.tenants.get(request.tenantId);
    validateArtifact(request.artifact);
    const invalidRegions = request.regions.filter(
      (region) => !policy.allowedRegions.includes(region),
    );
    if (invalidRegions.length > 0) {
      throw new PolicyViolationError(
        "tenant policy denies requested regions",
        { invalidRegions },
      );
    }
    if (request.environment === "production") {
      if (
        new Set(request.approvers).size
        < policy.productionApprovers
      ) {
        throw new PolicyViolationError(
          "not enough independent production approvals",
          {
            required: policy.productionApprovers,
            actual: new Set(request.approvers).size,
          },
        );
      }
      if (isFrozen(policy, this.clock.now())) {
        throw new PolicyViolationError(
          "production release freeze is active",
        );
      }
    }
    requirePercentage(
      request.canaryPercent,
      "request.canaryPercent",
    );
    if (request.canaryPercent > policy.maxCanaryPercent) {
      throw new PolicyViolationError(
        "requested canary exceeds tenant policy",
        {
          requested: request.canaryPercent,
          maximum: policy.maxCanaryPercent,
        },
      );
    }
    const plan: ReleasePlan = {
      id: stableId(
        "plan",
        request.tenantId,
        request.service,
        request.artifact.digest,
        request.environment,
      ),
      tenantId: request.tenantId,
      target: {
        service: requireSlug(request.service, "service"),
        environment: request.environment,
        regions: [...request.regions],
        desiredReplicas: Math.max(1, request.desiredReplicas),
      },
      artifact: request.artifact,
      stages: this.buildStages(
        request.regions,
        request.canaryPercent,
      ),
      createdBy: request.requestedBy,
      createdAt: this.clock.now(),
      approvals: [...new Set(request.approvers)],
    };
    return validateReleasePlan(plan);
  }

  private buildStages(
    regions: readonly string[],
    canaryPercent: number,
  ): readonly RolloutStage[] {
    const firstRegion = regions[0];
    if (!firstRegion) {
      throw new ValidationError(
        "release requires at least one region",
      );
    }
    return [
      {
        name: "canary",
        kind: "canary",
        trafficPercent: canaryPercent,
        regions: [firstRegion],
        minimumObservationMinutes: 10,
        requiredHealthyChecks: 3,
      },
      {
        name: "regional",
        kind: "regional",
        trafficPercent: 35,
        regions: [...regions],
        minimumObservationMinutes: 20,
        requiredHealthyChecks: 4,
      },
      {
        name: "global",
        kind: "global",
        trafficPercent: 100,
        regions: [...regions],
        minimumObservationMinutes: 30,
        requiredHealthyChecks: 6,
      },
    ];
  }
}

export class RolloutOrchestrator {
  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly slo: SloService,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
    private readonly traces: TraceCollector,
    private readonly counters: CounterRegistry,
    private readonly clock: Clock,
  ) {}

  async start(
    plan: ReleasePlan,
    baselineVersion: string,
    correlationId: string,
  ): Promise<Deployment> {
    return this.traces.trace(
      "rollout.start",
      {
        tenantId: plan.tenantId,
        service: plan.target.service,
      },
      async () => {
        const running: Deployment = {
          id: stableId("deployment", plan.id),
          plan,
          state: "running",
          currentStageIndex: 0,
          startedAt: this.clock.now(),
          baselineVersion,
          revision: 0,
        };
        const stored = this.deployments.save(running, 0);
        try {
          await this.runtime.deploy(
            stored,
            currentStage(stored),
          );
        } catch (error) {
          this.deployments.save(
            {
              ...stored,
              state: "failed",
              finishedAt: this.clock.now(),
            },
            stored.revision,
          );
          this.counters.increment(
            "fleet_release_total",
            {
              outcome: "failed",
              environment: plan.target.environment,
            },
          );
          throw error;
        }
        this.audit.record(
          plan.tenantId,
          plan.createdBy,
          "release.started",
          "deployment",
          stored.id,
          { stage: currentStage(stored).name },
          correlationId,
        );
        this.counters.increment(
          "fleet_release_total",
          {
            outcome: "started",
            environment: plan.target.environment,
          },
        );
        return stored;
      },
    );
  }

  async promotionDecision(
    deploymentId: string,
    definition: SloDefinition,
  ): Promise<PromotionDecision> {
    const deployment = this.deployments.get(deploymentId);
    if (deployment.state !== "running") {
      return {
        allowed: false,
        reason: "deployment_not_running",
      };
    }
    const assessment = await this.slo.assess(
      definition,
      currentStage(deployment).regions,
    );
    if (!assessment.healthy) {
      return {
        allowed: false,
        reason: "slo_gate_failed",
        assessment,
      };
    }
    return {
      allowed: true,
      reason: "slo_gate_passed",
      assessment,
    };
  }

  async promote(
    deploymentId: string,
    actor: string,
    definition: SloDefinition,
    correlationId: string,
  ): Promise<Deployment> {
    const current = this.deployments.get(deploymentId);
    const decision = await this.promotionDecision(
      deploymentId,
      definition,
    );
    if (!decision.allowed) {
      if (decision.assessment) {
        await this.alerts.openForAssessment(
          current.plan.tenantId,
          decision.assessment,
          correlationId,
        );
      }
      throw new PolicyViolationError(
        "rollout promotion denied",
        { reason: decision.reason },
      );
    }
    const nextIndex = current.currentStageIndex + 1;
    if (nextIndex >= current.plan.stages.length) {
      const succeeded = this.deployments.save(
        {
          ...current,
          state: "succeeded",
          finishedAt: this.clock.now(),
        },
        current.revision,
      );
      this.counters.increment(
        "fleet_release_total",
        {
          outcome: "succeeded",
          environment: current.plan.target.environment,
        },
      );
      return succeeded;
    }
    const promoted = this.deployments.save(
      {
        ...current,
        currentStageIndex: nextIndex,
      },
      current.revision,
    );
    try {
      await this.runtime.deploy(
        promoted,
        currentStage(promoted),
      );
    } catch (error) {
      this.deployments.save(
        {
          ...promoted,
          state: "paused",
        },
        promoted.revision,
      );
      throw error;
    }
    this.audit.record(
      current.plan.tenantId,
      actor,
      "release.stage_promoted",
      "deployment",
      current.id,
      { stage: currentStage(promoted).name },
      correlationId,
    );
    this.counters.increment(
      "fleet_promotion_total",
      { stage: currentStage(promoted).name },
    );
    return promoted;
  }

  async rollback(
    deploymentId: string,
    actor: string,
    reason: string,
    correlationId: string,
  ): Promise<Deployment> {
    const current = this.deployments.get(deploymentId);
    if (isTerminalState(current.state)) {
      throw new ConflictError(
        "terminal deployment cannot be rolled back",
      );
    }
    if (!current.baselineVersion) {
      throw new PolicyViolationError(
        "rollback baseline is unavailable",
      );
    }
    const rollingBack = this.deployments.save(
      {
        ...current,
        state: "rolling_back",
        rollbackReason: reason,
      },
      current.revision,
    );
    try {
      await this.runtime.rollback(
        rollingBack,
        current.baselineVersion,
      );
    } catch (error) {
      this.deployments.save(
        {
          ...rollingBack,
          state: "failed",
          finishedAt: this.clock.now(),
        },
        rollingBack.revision,
      );
      throw error;
    }
    const completed = this.deployments.save(
      {
        ...rollingBack,
        state: "rolled_back",
        finishedAt: this.clock.now(),
      },
      rollingBack.revision,
    );
    this.audit.record(
      current.plan.tenantId,
      actor,
      "release.rolled_back",
      "deployment",
      current.id,
      { reason },
      correlationId,
    );
    this.counters.increment(
      "fleet_release_total",
      {
        outcome: "rolled_back",
        environment: current.plan.target.environment,
      },
    );
    return completed;
  }
}

export interface TenantFixture {
  readonly policy: TenantPolicy;
  readonly owner: string;
  readonly primaryService: string;
  readonly alertChannel: string;
  readonly expectedMonthlyReleases: number;
}

export interface RolloutFixture {
  readonly name: string;
  readonly tenantId: string;
  readonly service: string;
  readonly environment: Environment;
  readonly regions: readonly string[];
  readonly canaryPercent: number;
  readonly availability: number;
  readonly latencyP95Ms: number;
  readonly expectedAction: "promote" | "pause" | "rollback";
}

export const FIXTURE_BASE_TIME = new Date(
  "2026-08-12T09:00:00.000Z",
);

export const TENANT_FIXTURES = [
  {
    policy: {
      id: "atlas-retail",
      displayName: "Atlas Retail",
      tier: "enterprise",
      allowedRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      productionApprovers: 2,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-blue-01",
    primaryService: "checkout-api",
    alertChannel: "#fleet-atlas-retail",
    expectedMonthlyReleases: 8,
  },
  {
    policy: {
      id: "boreal-bank",
      displayName: "Boreal Bank",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-02",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-boreal-bank",
    expectedMonthlyReleases: 11,
  },
  {
    policy: {
      id: "cinder-media",
      displayName: "Cinder Media",
      tier: "starter",
      allowedRegions: ["eu-west-1", "eu-central-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-03",
    primaryService: "event-router",
    alertChannel: "#fleet-cinder-media",
    expectedMonthlyReleases: 14,
  },
  {
    policy: {
      id: "delta-health",
      displayName: "Delta Health",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-04",
    primaryService: "policy-engine",
    alertChannel: "#fleet-delta-health",
    expectedMonthlyReleases: 17,
  },
  {
    policy: {
      id: "ember-logistics",
      displayName: "Ember Logistics",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "us-east-1", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-05",
    primaryService: "catalog-read",
    alertChannel: "#fleet-ember-logistics",
    expectedMonthlyReleases: 20,
  },
  {
    policy: {
      id: "fjord-energy",
      displayName: "Fjord Energy",
      tier: "enterprise",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 2,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-06",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-fjord-energy",
    expectedMonthlyReleases: 23,
  },
  {
    policy: {
      id: "grove-learning",
      displayName: "Grove Learning",
      tier: "growth",
      allowedRegions: ["us-east-1", "us-west-2"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-green-07",
    primaryService: "billing-worker",
    alertChannel: "#fleet-grove-learning",
    expectedMonthlyReleases: 26,
  },
  {
    policy: {
      id: "harbor-travel",
      displayName: "Harbor Travel",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-orange-08",
    primaryService: "search-indexer",
    alertChannel: "#fleet-harbor-travel",
    expectedMonthlyReleases: 29,
  },
  {
    policy: {
      id: "indigo-labs",
      displayName: "Indigo Labs",
      tier: "starter",
      allowedRegions: ["eu-west-1", "ap-southeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-09",
    primaryService: "notification-hub",
    alertChannel: "#fleet-indigo-labs",
    expectedMonthlyReleases: 32,
  },
  {
    policy: {
      id: "juniper-pay",
      displayName: "Juniper Pay",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-10",
    primaryService: "edge-config",
    alertChannel: "#fleet-juniper-pay",
    expectedMonthlyReleases: 35,
  },
  {
    policy: {
      id: "keystone-cloud",
      displayName: "Keystone Cloud",
      tier: "enterprise",
      allowedRegions: ["ap-southeast-1", "ap-northeast-1"],
      productionApprovers: 2,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-11",
    primaryService: "checkout-api",
    alertChannel: "#fleet-keystone-cloud",
    expectedMonthlyReleases: 38,
  },
  {
    policy: {
      id: "lattice-games",
      displayName: "Lattice Games",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-12",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-lattice-games",
    expectedMonthlyReleases: 41,
  },
  {
    policy: {
      id: "meridian-food",
      displayName: "Meridian Food",
      tier: "growth",
      allowedRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-orange-13",
    primaryService: "event-router",
    alertChannel: "#fleet-meridian-food",
    expectedMonthlyReleases: 8,
  },
  {
    policy: {
      id: "northstar-auto",
      displayName: "Northstar Auto",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-14",
    primaryService: "policy-engine",
    alertChannel: "#fleet-northstar-auto",
    expectedMonthlyReleases: 11,
  },
  {
    policy: {
      id: "opal-security",
      displayName: "Opal Security",
      tier: "starter",
      allowedRegions: ["eu-west-1", "eu-central-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-teal-15",
    primaryService: "catalog-read",
    alertChannel: "#fleet-opal-security",
    expectedMonthlyReleases: 14,
  },
  {
    policy: {
      id: "prairie-ai",
      displayName: "Prairie Ai",
      tier: "enterprise",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 2,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-16",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-prairie-ai",
    expectedMonthlyReleases: 17,
  },
  {
    policy: {
      id: "quartz-robotics",
      displayName: "Quartz Robotics",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "us-east-1", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-17",
    primaryService: "billing-worker",
    alertChannel: "#fleet-quartz-robotics",
    expectedMonthlyReleases: 20,
  },
  {
    policy: {
      id: "rivet-commerce",
      displayName: "Rivet Commerce",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-18",
    primaryService: "search-indexer",
    alertChannel: "#fleet-rivet-commerce",
    expectedMonthlyReleases: 23,
  },
  {
    policy: {
      id: "summit-insurance",
      displayName: "Summit Insurance",
      tier: "growth",
      allowedRegions: ["us-east-1", "us-west-2"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-violet-19",
    primaryService: "notification-hub",
    alertChannel: "#fleet-summit-insurance",
    expectedMonthlyReleases: 26,
  },
  {
    policy: {
      id: "tundra-mobile",
      displayName: "Tundra Mobile",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-20",
    primaryService: "edge-config",
    alertChannel: "#fleet-tundra-mobile",
    expectedMonthlyReleases: 29,
  },
  {
    policy: {
      id: "uplink-data",
      displayName: "Uplink Data",
      tier: "enterprise",
      allowedRegions: ["eu-west-1", "ap-southeast-1", "us-east-1"],
      productionApprovers: 2,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-21",
    primaryService: "checkout-api",
    alertChannel: "#fleet-uplink-data",
    expectedMonthlyReleases: 32,
  },
  {
    policy: {
      id: "valley-homes",
      displayName: "Valley Homes",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-green-22",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-valley-homes",
    expectedMonthlyReleases: 35,
  },
  {
    policy: {
      id: "willow-social",
      displayName: "Willow Social",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "ap-northeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-23",
    primaryService: "event-router",
    alertChannel: "#fleet-willow-social",
    expectedMonthlyReleases: 38,
  },
  {
    policy: {
      id: "xenon-biotech",
      displayName: "Xenon Biotech",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-24",
    primaryService: "policy-engine",
    alertChannel: "#fleet-xenon-biotech",
    expectedMonthlyReleases: 41,
  },
  {
    policy: {
      id: "yonder-maps",
      displayName: "Yonder Maps",
      tier: "growth",
      allowedRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-teal-25",
    primaryService: "catalog-read",
    alertChannel: "#fleet-yonder-maps",
    expectedMonthlyReleases: 8,
  },
  {
    policy: {
      id: "zenith-stream",
      displayName: "Zenith Stream",
      tier: "enterprise",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 2,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-26",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-zenith-stream",
    expectedMonthlyReleases: 11,
  },
  {
    policy: {
      id: "aurora-civic",
      displayName: "Aurora Civic",
      tier: "starter",
      allowedRegions: ["eu-west-1", "eu-central-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-27",
    primaryService: "billing-worker",
    alertChannel: "#fleet-aurora-civic",
    expectedMonthlyReleases: 14,
  },
  {
    policy: {
      id: "bramble-books",
      displayName: "Bramble Books",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-28",
    primaryService: "search-indexer",
    alertChannel: "#fleet-bramble-books",
    expectedMonthlyReleases: 17,
  },
  {
    policy: {
      id: "coral-design",
      displayName: "Coral Design",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "us-east-1", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-violet-29",
    primaryService: "notification-hub",
    alertChannel: "#fleet-coral-design",
    expectedMonthlyReleases: 20,
  },
  {
    policy: {
      id: "drift-finance",
      displayName: "Drift Finance",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-30",
    primaryService: "edge-config",
    alertChannel: "#fleet-drift-finance",
    expectedMonthlyReleases: 23,
  },
  {
    policy: {
      id: "elm-mobility",
      displayName: "Elm Mobility",
      tier: "enterprise",
      allowedRegions: ["us-east-1", "us-west-2"],
      productionApprovers: 2,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-blue-31",
    primaryService: "checkout-api",
    alertChannel: "#fleet-elm-mobility",
    expectedMonthlyReleases: 26,
  },
  {
    policy: {
      id: "forge-analytics",
      displayName: "Forge Analytics",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-32",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-forge-analytics",
    expectedMonthlyReleases: 29,
  },
  {
    policy: {
      id: "glacier-storage",
      displayName: "Glacier Storage",
      tier: "starter",
      allowedRegions: ["eu-west-1", "ap-southeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-33",
    primaryService: "event-router",
    alertChannel: "#fleet-glacier-storage",
    expectedMonthlyReleases: 32,
  },
  {
    policy: {
      id: "hearth-market",
      displayName: "Hearth Market",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-34",
    primaryService: "policy-engine",
    alertChannel: "#fleet-hearth-market",
    expectedMonthlyReleases: 35,
  },
  {
    policy: {
      id: "ion-weather",
      displayName: "Ion Weather",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "ap-northeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-35",
    primaryService: "catalog-read",
    alertChannel: "#fleet-ion-weather",
    expectedMonthlyReleases: 38,
  },
  {
    policy: {
      id: "jade-identity",
      displayName: "Jade Identity",
      tier: "enterprise",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 2,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-blue-36",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-jade-identity",
    expectedMonthlyReleases: 41,
  },
  {
    policy: {
      id: "kestrel-devtools",
      displayName: "Kestrel Devtools",
      tier: "growth",
      allowedRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-green-37",
    primaryService: "billing-worker",
    alertChannel: "#fleet-kestrel-devtools",
    expectedMonthlyReleases: 8,
  },
  {
    policy: {
      id: "lagoon-supply",
      displayName: "Lagoon Supply",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-38",
    primaryService: "search-indexer",
    alertChannel: "#fleet-lagoon-supply",
    expectedMonthlyReleases: 11,
  },
  {
    policy: {
      id: "meadow-voice",
      displayName: "Meadow Voice",
      tier: "starter",
      allowedRegions: ["eu-west-1", "eu-central-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-39",
    primaryService: "notification-hub",
    alertChannel: "#fleet-meadow-voice",
    expectedMonthlyReleases: 14,
  },
  {
    policy: {
      id: "nova-search",
      displayName: "Nova Search",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-40",
    primaryService: "edge-config",
    alertChannel: "#fleet-nova-search",
    expectedMonthlyReleases: 17,
  },
  {
    policy: {
      id: "orbit-photos",
      displayName: "Orbit Photos",
      tier: "enterprise",
      allowedRegions: ["ap-southeast-1", "us-east-1", "eu-west-1"],
      productionApprovers: 2,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-41",
    primaryService: "checkout-api",
    alertChannel: "#fleet-orbit-photos",
    expectedMonthlyReleases: 20,
  },
  {
    policy: {
      id: "pine-observability",
      displayName: "Pine Observability",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-42",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-pine-observability",
    expectedMonthlyReleases: 23,
  },
  {
    policy: {
      id: "quiver-support",
      displayName: "Quiver Support",
      tier: "growth",
      allowedRegions: ["us-east-1", "us-west-2"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-orange-43",
    primaryService: "event-router",
    alertChannel: "#fleet-quiver-support",
    expectedMonthlyReleases: 26,
  },
  {
    policy: {
      id: "ridge-network",
      displayName: "Ridge Network",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-44",
    primaryService: "policy-engine",
    alertChannel: "#fleet-ridge-network",
    expectedMonthlyReleases: 29,
  },
  {
    policy: {
      id: "spruce-workflows",
      displayName: "Spruce Workflows",
      tier: "starter",
      allowedRegions: ["eu-west-1", "ap-southeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-45",
    primaryService: "catalog-read",
    alertChannel: "#fleet-spruce-workflows",
    expectedMonthlyReleases: 32,
  },
  {
    policy: {
      id: "terra-catalog",
      displayName: "Terra Catalog",
      tier: "enterprise",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 2,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-46",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-terra-catalog",
    expectedMonthlyReleases: 35,
  },
  {
    policy: {
      id: "umber-compute",
      displayName: "Umber Compute",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "ap-northeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-green-47",
    primaryService: "billing-worker",
    alertChannel: "#fleet-umber-compute",
    expectedMonthlyReleases: 38,
  },
  {
    policy: {
      id: "vista-collaboration",
      displayName: "Vista Collaboration",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-48",
    primaryService: "search-indexer",
    alertChannel: "#fleet-vista-collaboration",
    expectedMonthlyReleases: 41,
  },
  {
    policy: {
      id: "wave-payments",
      displayName: "Wave Payments",
      tier: "growth",
      allowedRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-violet-49",
    primaryService: "notification-hub",
    alertChannel: "#fleet-wave-payments",
    expectedMonthlyReleases: 8,
  },
  {
    policy: {
      id: "zephyr-edge",
      displayName: "Zephyr Edge",
      tier: "starter",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-teal-50",
    primaryService: "edge-config",
    alertChannel: "#fleet-zephyr-edge",
    expectedMonthlyReleases: 11,
  },
  {
    policy: {
      id: "acorn-legal",
      displayName: "Acorn Legal",
      tier: "enterprise",
      allowedRegions: ["eu-west-1", "eu-central-1"],
      productionApprovers: 2,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-51",
    primaryService: "checkout-api",
    alertChannel: "#fleet-acorn-legal",
    expectedMonthlyReleases: 14,
  },
  {
    policy: {
      id: "beacon-news",
      displayName: "Beacon News",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-green-52",
    primaryService: "identity-gateway",
    alertChannel: "#fleet-beacon-news",
    expectedMonthlyReleases: 17,
  },
  {
    policy: {
      id: "cascade-sports",
      displayName: "Cascade Sports",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "us-east-1", "eu-west-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-53",
    primaryService: "event-router",
    alertChannel: "#fleet-cascade-sports",
    expectedMonthlyReleases: 20,
  },
  {
    policy: {
      id: "dawn-agriculture",
      displayName: "Dawn Agriculture",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-54",
    primaryService: "policy-engine",
    alertChannel: "#fleet-dawn-agriculture",
    expectedMonthlyReleases: 23,
  },
  {
    policy: {
      id: "echo-messaging",
      displayName: "Echo Messaging",
      tier: "growth",
      allowedRegions: ["us-east-1", "us-west-2"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [[22, 6]],
    },
    owner: "team-teal-55",
    primaryService: "catalog-read",
    alertChannel: "#fleet-echo-messaging",
    expectedMonthlyReleases: 26,
  },
  {
    policy: {
      id: "flint-construction",
      displayName: "Flint Construction",
      tier: "enterprise",
      allowedRegions: ["us-west-2", "eu-west-1"],
      productionApprovers: 2,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.95,
      freezeWindowsUtc: [],
    },
    owner: "team-blue-56",
    primaryService: "media-transcoder",
    alertChannel: "#fleet-flint-construction",
    expectedMonthlyReleases: 29,
  },
  {
    policy: {
      id: "garden-productivity",
      displayName: "Garden Productivity",
      tier: "starter",
      allowedRegions: ["eu-west-1", "ap-southeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 5,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [[0, 4], [18, 20]],
    },
    owner: "team-green-57",
    primaryService: "billing-worker",
    alertChannel: "#fleet-garden-productivity",
    expectedMonthlyReleases: 32,
  },
  {
    policy: {
      id: "horizon-events",
      displayName: "Horizon Events",
      tier: "growth",
      allowedRegions: ["eu-central-1", "ap-southeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 10,
      minimumSloTarget: 99.9,
      freezeWindowsUtc: [],
    },
    owner: "team-orange-58",
    primaryService: "search-indexer",
    alertChannel: "#fleet-horizon-events",
    expectedMonthlyReleases: 35,
  },
  {
    policy: {
      id: "island-delivery",
      displayName: "Island Delivery",
      tier: "starter",
      allowedRegions: ["ap-southeast-1", "ap-northeast-1"],
      productionApprovers: 1,
      maxCanaryPercent: 15,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-violet-59",
    primaryService: "notification-hub",
    alertChannel: "#fleet-island-delivery",
    expectedMonthlyReleases: 38,
  },
  {
    policy: {
      id: "jetstream-video",
      displayName: "Jetstream Video",
      tier: "starter",
      allowedRegions: ["ap-northeast-1", "us-east-1"],
      productionApprovers: 1,
      maxCanaryPercent: 20,
      minimumSloTarget: 99.5,
      freezeWindowsUtc: [],
    },
    owner: "team-teal-60",
    primaryService: "edge-config",
    alertChannel: "#fleet-jetstream-video",
    expectedMonthlyReleases: 41,
  },
] satisfies readonly TenantFixture[];

export const ROLLOUT_FIXTURES = [
  {
    name: "atlas-retail-checkout-api-01",
    tenantId: "atlas-retail",
    service: "checkout-api",
    environment: "staging",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 5,
    availability: 99.95,
    latencyP95Ms: 170.0,
    expectedAction: "promote",
  },
  {
    name: "boreal-bank-policy-engine-02",
    tenantId: "boreal-bank",
    service: "policy-engine",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 10,
    availability: 99.96,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "cinder-media-billing-worker-03",
    tenantId: "cinder-media",
    service: "billing-worker",
    environment: "production",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 15,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "delta-health-edge-config-04",
    tenantId: "delta-health",
    service: "edge-config",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "ember-logistics-event-router-05",
    tenantId: "ember-logistics",
    service: "event-router",
    environment: "staging",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 5,
    availability: 99.96,
    latencyP95Ms: 230.0,
    expectedAction: "promote",
  },
  {
    name: "fjord-energy-media-transcoder-06",
    tenantId: "fjord-energy",
    service: "media-transcoder",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "grove-learning-notification-hub-07",
    tenantId: "grove-learning",
    service: "notification-hub",
    environment: "production",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 15,
    availability: 99.95,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "harbor-travel-identity-gateway-08",
    tenantId: "harbor-travel",
    service: "identity-gateway",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 20,
    availability: 99.96,
    latencyP95Ms: 200.0,
    expectedAction: "promote",
  },
  {
    name: "indigo-labs-catalog-read-09",
    tenantId: "indigo-labs",
    service: "catalog-read",
    environment: "staging",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 5,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "juniper-pay-search-indexer-10",
    tenantId: "juniper-pay",
    service: "search-indexer",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "keystone-cloud-checkout-api-11",
    tenantId: "keystone-cloud",
    service: "checkout-api",
    environment: "production",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 15,
    availability: 99.96,
    latencyP95Ms: 170.0,
    expectedAction: "promote",
  },
  {
    name: "lattice-games-policy-engine-12",
    tenantId: "lattice-games",
    service: "policy-engine",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "meridian-food-billing-worker-13",
    tenantId: "meridian-food",
    service: "billing-worker",
    environment: "staging",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 5,
    availability: 99.95,
    latencyP95Ms: 200.0,
    expectedAction: "promote",
  },
  {
    name: "northstar-auto-edge-config-14",
    tenantId: "northstar-auto",
    service: "edge-config",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 10,
    availability: 99.96,
    latencyP95Ms: 215.0,
    expectedAction: "promote",
  },
  {
    name: "opal-security-event-router-15",
    tenantId: "opal-security",
    service: "event-router",
    environment: "production",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 15,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "prairie-ai-media-transcoder-16",
    tenantId: "prairie-ai",
    service: "media-transcoder",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "quartz-robotics-notification-hub-17",
    tenantId: "quartz-robotics",
    service: "notification-hub",
    environment: "staging",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 5,
    availability: 99.96,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "rivet-commerce-identity-gateway-18",
    tenantId: "rivet-commerce",
    service: "identity-gateway",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "summit-insurance-catalog-read-19",
    tenantId: "summit-insurance",
    service: "catalog-read",
    environment: "production",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 15,
    availability: 99.95,
    latencyP95Ms: 215.0,
    expectedAction: "promote",
  },
  {
    name: "tundra-mobile-search-indexer-20",
    tenantId: "tundra-mobile",
    service: "search-indexer",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 20,
    availability: 99.96,
    latencyP95Ms: 230.0,
    expectedAction: "promote",
  },
  {
    name: "uplink-data-checkout-api-21",
    tenantId: "uplink-data",
    service: "checkout-api",
    environment: "staging",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 5,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "valley-homes-policy-engine-22",
    tenantId: "valley-homes",
    service: "policy-engine",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "willow-social-billing-worker-23",
    tenantId: "willow-social",
    service: "billing-worker",
    environment: "production",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 15,
    availability: 99.96,
    latencyP95Ms: 200.0,
    expectedAction: "promote",
  },
  {
    name: "xenon-biotech-edge-config-24",
    tenantId: "xenon-biotech",
    service: "edge-config",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "yonder-maps-event-router-25",
    tenantId: "yonder-maps",
    service: "event-router",
    environment: "staging",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 5,
    availability: 99.95,
    latencyP95Ms: 230.0,
    expectedAction: "promote",
  },
  {
    name: "zenith-stream-media-transcoder-26",
    tenantId: "zenith-stream",
    service: "media-transcoder",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 10,
    availability: 99.96,
    latencyP95Ms: 170.0,
    expectedAction: "promote",
  },
  {
    name: "aurora-civic-notification-hub-27",
    tenantId: "aurora-civic",
    service: "notification-hub",
    environment: "production",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 15,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "bramble-books-identity-gateway-28",
    tenantId: "bramble-books",
    service: "identity-gateway",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "coral-design-catalog-read-29",
    tenantId: "coral-design",
    service: "catalog-read",
    environment: "staging",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 5,
    availability: 99.96,
    latencyP95Ms: 215.0,
    expectedAction: "promote",
  },
  {
    name: "drift-finance-search-indexer-30",
    tenantId: "drift-finance",
    service: "search-indexer",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "elm-mobility-checkout-api-31",
    tenantId: "elm-mobility",
    service: "checkout-api",
    environment: "production",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 15,
    availability: 99.95,
    latencyP95Ms: 170.0,
    expectedAction: "promote",
  },
  {
    name: "forge-analytics-policy-engine-32",
    tenantId: "forge-analytics",
    service: "policy-engine",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 20,
    availability: 99.96,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "glacier-storage-billing-worker-33",
    tenantId: "glacier-storage",
    service: "billing-worker",
    environment: "staging",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 5,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "hearth-market-edge-config-34",
    tenantId: "hearth-market",
    service: "edge-config",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "ion-weather-event-router-35",
    tenantId: "ion-weather",
    service: "event-router",
    environment: "production",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 15,
    availability: 99.96,
    latencyP95Ms: 230.0,
    expectedAction: "promote",
  },
  {
    name: "jade-identity-media-transcoder-36",
    tenantId: "jade-identity",
    service: "media-transcoder",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "kestrel-devtools-notification-hub-37",
    tenantId: "kestrel-devtools",
    service: "notification-hub",
    environment: "staging",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 5,
    availability: 99.95,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "lagoon-supply-identity-gateway-38",
    tenantId: "lagoon-supply",
    service: "identity-gateway",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 10,
    availability: 99.96,
    latencyP95Ms: 200.0,
    expectedAction: "promote",
  },
  {
    name: "meadow-voice-catalog-read-39",
    tenantId: "meadow-voice",
    service: "catalog-read",
    environment: "production",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 15,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "nova-search-search-indexer-40",
    tenantId: "nova-search",
    service: "search-indexer",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "orbit-photos-checkout-api-41",
    tenantId: "orbit-photos",
    service: "checkout-api",
    environment: "staging",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 5,
    availability: 99.96,
    latencyP95Ms: 170.0,
    expectedAction: "promote",
  },
  {
    name: "pine-observability-policy-engine-42",
    tenantId: "pine-observability",
    service: "policy-engine",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
  {
    name: "quiver-support-billing-worker-43",
    tenantId: "quiver-support",
    service: "billing-worker",
    environment: "production",
    regions: ["us-east-1", "us-west-2"],
    canaryPercent: 15,
    availability: 99.95,
    latencyP95Ms: 200.0,
    expectedAction: "promote",
  },
  {
    name: "ridge-network-edge-config-44",
    tenantId: "ridge-network",
    service: "edge-config",
    environment: "production",
    regions: ["us-west-2", "eu-west-1"],
    canaryPercent: 20,
    availability: 99.96,
    latencyP95Ms: 215.0,
    expectedAction: "promote",
  },
  {
    name: "spruce-workflows-event-router-45",
    tenantId: "spruce-workflows",
    service: "event-router",
    environment: "staging",
    regions: ["eu-west-1", "eu-central-1"],
    canaryPercent: 5,
    availability: 99.82,
    latencyP95Ms: 410.0,
    expectedAction: "pause",
  },
  {
    name: "terra-catalog-media-transcoder-46",
    tenantId: "terra-catalog",
    service: "media-transcoder",
    environment: "production",
    regions: ["eu-central-1", "ap-southeast-1"],
    canaryPercent: 10,
    availability: 98.90,
    latencyP95Ms: 770.0,
    expectedAction: "rollback",
  },
  {
    name: "umber-compute-notification-hub-47",
    tenantId: "umber-compute",
    service: "notification-hub",
    environment: "production",
    regions: ["ap-southeast-1", "ap-northeast-1"],
    canaryPercent: 15,
    availability: 99.96,
    latencyP95Ms: 185.0,
    expectedAction: "promote",
  },
  {
    name: "vista-collaboration-identity-gateway-48",
    tenantId: "vista-collaboration",
    service: "identity-gateway",
    environment: "production",
    regions: ["ap-northeast-1", "us-east-1"],
    canaryPercent: 20,
    availability: 99.30,
    latencyP95Ms: 850.0,
    expectedAction: "rollback",
  },
] satisfies readonly RolloutFixture[];

export function fixtureArtifact(index = 1): Artifact {
  const serial = index.toString(16).padStart(64, "0");
  return {
    digest: "sha256:" + serial,
    version: "2." + index % 20 + "." + index % 11,
    sourceRevision: index.toString(16).padStart(40, "0"),
    createdAt: addMinutes(FIXTURE_BASE_TIME, -index),
    sbomReference: "sbom://kiron/release-"
      + String(index).padStart(3, "0"),
  };
}

export function buildFixtureMetrics(
  fixture: RolloutFixture,
): readonly MetricSnapshot[] {
  const requestCount = 100_000;
  const errorCount = Math.round(
    requestCount * (100 - fixture.availability) / 100,
  );
  return fixture.regions.map((region) => ({
    service: fixture.service,
    environment: fixture.environment,
    region,
    sampledAt: copyDate(FIXTURE_BASE_TIME),
    requestCount,
    errorCount,
    latencyP95Ms: fixture.latencyP95Ms,
  }));
}

export interface ControlPlaneFixture {
  readonly planner: ReleasePlanner;
  readonly orchestrator: RolloutOrchestrator;
  readonly flags: FeatureFlagService;
  readonly clock: FrozenClock;
  readonly deployments: DeploymentRepository;
  readonly runtime: RecordingRuntimeAdapter;
  readonly audit: AuditRepository;
  readonly notifications: RecordingNotificationAdapter;
  readonly counters: CounterRegistry;
}

export function buildControlPlane(
  metricRecords: readonly MetricSnapshot[],
): ControlPlaneFixture {
  const clock = new FrozenClock(FIXTURE_BASE_TIME);
  const tenants = new TenantRepository(
    TENANT_FIXTURES.map((fixture) => fixture.policy),
  );
  const deployments = new DeploymentRepository();
  const runtime = new RecordingRuntimeAdapter();
  const audit = new AuditRepository();
  const auditService = new AuditService(audit, clock);
  const notifications = new RecordingNotificationAdapter();
  const metricAdapter = new FixtureMetricsAdapter(metricRecords);
  const slo = new SloService(metricAdapter, clock);
  const alertRepository = new AlertRepository();
  const alerts = new AlertService(
    alertRepository,
    notifications,
    auditService,
    clock,
  );
  const counters = new CounterRegistry();
  const traces = new TraceCollector(clock);
  const flagRepository = new FlagRepository([
    {
      id: "flag_progressive_checkout",
      tenantId: "atlas-retail",
      key: "progressive-checkout",
      enabled: true,
      defaultValue: false,
      rules: [
        {
          id: "enterprise-us-canary",
          description: "Enable the checkout path for a stable cohort",
          percentage: 10,
          regions: ["us-east-1"],
          tenantTiers: ["enterprise"],
          attributes: {},
        },
      ],
      version: 1,
      updatedAt: clock.now(),
    },
  ]);
  const planner = new ReleasePlanner(tenants, clock);
  const orchestrator = new RolloutOrchestrator(
    deployments,
    runtime,
    slo,
    alerts,
    auditService,
    traces,
    counters,
    clock,
  );
  const flags = new FeatureFlagService(
    flagRepository,
    auditService,
    clock,
  );
  return {
    planner,
    orchestrator,
    flags,
    clock,
    deployments,
    runtime,
    audit,
    notifications,
    counters,
  };
}

export function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function assertRejects<TError extends Error>(
  errorType: new (...args: never[]) => TError,
  callback: () => Promise<unknown>,
): Promise<TError> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof errorType) {
      return error;
    }
    throw new Error(
      "expected "
      + errorType.name
      + ", received "
      + (error instanceof Error ? error.name : typeof error),
    );
  }
  throw new Error("expected " + errorType.name + " to be thrown");
}

export function policyFor(tenantId: string): TenantPolicy {
  const fixture = TENANT_FIXTURES.find(
    (candidate) => candidate.policy.id === tenantId,
  );
  if (!fixture) {
    throw new NotFoundError(
      "fixture tenant not found",
      { tenantId },
    );
  }
  return fixture.policy;
}

export function stagingRequest(
  fixture: RolloutFixture,
  artifactIndex: number,
): ReleaseRequest {
  const policy = policyFor(fixture.tenantId);
  return {
    tenantId: fixture.tenantId,
    service: fixture.service,
    environment: "staging",
    regions: policy.allowedRegions.slice(0, 2),
    artifact: fixtureArtifact(artifactIndex),
    requestedBy: "release-bot@kiron.dev",
    approvers: ["reviewer@kiron.dev"],
    desiredReplicas: 3,
    canaryPercent: Math.min(
      DEFAULT_CANARY_PERCENT,
      policy.maxCanaryPercent,
    ),
  };
}

export function testValidationRejectsMalformedArtifact(): void {
  const artifact: Artifact = {
    digest: "latest",
    version: "not-semver",
    sourceRevision: "abc",
    createdAt: FIXTURE_BASE_TIME,
    sbomReference: "https://example.test/sbom",
  };
  let received: unknown;
  try {
    validateArtifact(artifact);
  } catch (error) {
    received = error;
  }
  assert(
    received instanceof ValidationError,
    "malformed artifact should be rejected",
  );
}

export function testFeatureFlagIsDeterministic(): void {
  const fixture = buildControlPlane(
    buildFixtureMetrics(ROLLOUT_FIXTURES[0]),
  );
  const context: FlagContext = {
    subjectId: "account-1042",
    region: "us-east-1",
    tenantTier: "enterprise",
    attributes: { plan: "annual" },
  };
  const first = fixture.flags.evaluate(
    "atlas-retail",
    "progressive-checkout",
    context,
  );
  const second = fixture.flags.evaluate(
    "atlas-retail",
    "progressive-checkout",
    context,
  );
  assert(
    JSON.stringify(first) === JSON.stringify(second),
    "flag decision must be deterministic",
  );
}

export async function testReleaseStartsAtCanary(): Promise<void> {
  const rollout = ROLLOUT_FIXTURES[1];
  const fixture = buildControlPlane(
    buildFixtureMetrics(rollout),
  );
  const request = stagingRequest(rollout, 2);
  const plan = fixture.planner.create(request);
  const deployment = await fixture.orchestrator.start(
    plan,
    "2.0.0",
    "corr-start-canary",
  );
  assert(deployment.state === "running");
  assert(currentStage(deployment).kind === "canary");
  assert(fixture.runtime.deployments.at(-1)?.stage === "canary");
  assert(fixture.deployments.get(deployment.id).revision === 1);
  assert(
    fixture.audit.query(rollout.tenantId).at(0)?.action
      === "release.started",
  );
  assert(
    fixture.counters.value(
      "fleet_release_total",
      {
        outcome: "started",
        environment: "staging",
      },
    ) === 1,
  );
}

export async function testFailedSloOpensAlert(): Promise<void> {
  const rollout = ROLLOUT_FIXTURES.find(
    (candidate) => candidate.expectedAction === "rollback",
  );
  assert(rollout);
  const metricRecords = buildFixtureMetrics(rollout);
  const fixture = buildControlPlane(metricRecords);
  const plan = fixture.planner.create(
    stagingRequest(rollout, 3),
  );
  const deployment = await fixture.orchestrator.start(
    plan,
    "1.9.8",
    "corr-unhealthy-start",
  );
  const definition: SloDefinition = {
    service: rollout.service,
    environment: "staging",
    availabilityTarget: 99.9,
    latencyP95Ms: 300,
    windowMinutes: 60,
  };
  await assertRejects(
    PolicyViolationError,
    () => fixture.orchestrator.promote(
      deployment.id,
      "operator@kiron.dev",
      definition,
      "corr-unhealthy-promote",
    ),
  );
  assert(fixture.notifications.messages.length === 1);
  assert(
    fixture.audit.query(
      rollout.tenantId,
      { action: "alert.opened" },
    ).length === 1,
  );
}

export async function testRollbackRecordsBaseline(): Promise<void> {
  const rollout = ROLLOUT_FIXTURES[2];
  const fixture = buildControlPlane(
    buildFixtureMetrics(rollout),
  );
  const plan = fixture.planner.create(
    stagingRequest(rollout, 4),
  );
  const deployment = await fixture.orchestrator.start(
    plan,
    "2.3.4",
    "corr-rollback-start",
  );
  const completed = await fixture.orchestrator.rollback(
    deployment.id,
    "incident-commander@kiron.dev",
    "elevated checkout failures",
    "corr-rollback-finish",
  );
  assert(completed.state === "rolled_back");
  assert(
    fixture.runtime.rollbacks.at(-1)?.baselineVersion === "2.3.4",
  );
  assert(
    fixture.deployments.get(deployment.id).rollbackReason
      === "elevated checkout failures",
  );
  assert(
    fixture.audit.query(
      rollout.tenantId,
      { action: "release.rolled_back" },
    ).length === 1,
  );
}

export async function testOptimisticConcurrency(): Promise<void> {
  const rollout = ROLLOUT_FIXTURES[0];
  const fixture = buildControlPlane(
    buildFixtureMetrics(rollout),
  );
  const plan = fixture.planner.create(
    stagingRequest(rollout, 5),
  );
  const deployment = await fixture.orchestrator.start(
    plan,
    "2.4.0",
    "corr-concurrency",
  );
  fixture.deployments.save(
    {
      ...deployment,
      state: "paused",
    },
    deployment.revision,
  );
  let received: unknown;
  try {
    fixture.deployments.save(
      {
        ...deployment,
        state: "running",
      },
      deployment.revision,
    );
  } catch (error) {
    received = error;
  }
  assert(
    received instanceof ConflictError,
    "stale deployment update must fail",
  );
}

export async function testRuntimeFailureIsObserved(): Promise<void> {
  const rollout = ROLLOUT_FIXTURES[3];
  const fixture = buildControlPlane(
    buildFixtureMetrics(rollout),
  );
  fixture.runtime.failNextOperation = true;
  const plan = fixture.planner.create(
    stagingRequest(rollout, 6),
  );
  await assertRejects(
    AdapterError,
    () => fixture.orchestrator.start(
      plan,
      "2.5.1",
      "corr-runtime-failure",
    ),
  );
  assert(
    fixture.counters.value(
      "fleet_release_total",
      {
        outcome: "failed",
        environment: "staging",
      },
    ) === 1,
  );
}

export function describeFixtureCatalog(): string {
  const actionCounts = new Map<string, number>();
  for (const fixture of ROLLOUT_FIXTURES) {
    actionCounts.set(
      fixture.expectedAction,
      (actionCounts.get(fixture.expectedAction) ?? 0) + 1,
    );
  }
  const lines = [
    "Kiron Fleet Control Plane",
    "tenants=" + TENANT_FIXTURES.length,
    "rollouts=" + ROLLOUT_FIXTURES.length,
    ...[...actionCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([action, count]) => action + "=" + count),
  ];
  return lines.join("\n");
}

export async function runUnitFixtures(): Promise<readonly string[]> {
  const synchronousTests: ReadonlyArray<() => void> = [
    testValidationRejectsMalformedArtifact,
    testFeatureFlagIsDeterministic,
  ];
  const asynchronousTests: ReadonlyArray<() => Promise<void>> = [
    testReleaseStartsAtCanary,
    testFailedSloOpensAlert,
    testRollbackRecordsBaseline,
    testOptimisticConcurrency,
    testRuntimeFailureIsObserved,
  ];
  const completed: string[] = [];
  for (const test of synchronousTests) {
    test();
    completed.push(test.name);
  }
  for (const test of asynchronousTests) {
    await test();
    completed.push(test.name);
  }
  return completed;
}
