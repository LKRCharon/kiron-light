"use strict";

/**
 * Kiron Fleet Control Plane
 *
 * A dependency-free reference implementation for coordinating multi-tenant
 * releases across a regional service fleet. The file intentionally exercises
 * realistic JavaScript syntax while remaining useful as a theme playground.
 *
 * The control plane models five concerns:
 *   1. tenant-aware release planning and approval;
 *   2. feature-flag targeting and deterministic percentage rollout;
 *   3. append-only audit events;
 *   4. SLO evaluation, alerting, and rollout health gates;
 *   5. canary promotion, pause, resume, and rollback.
 */

const EnvironmentKind = Object.freeze({
  DEVELOPMENT: "development",
  STAGING: "staging",
  PRODUCTION: "production",
});

const TenantTier = Object.freeze({
  STANDARD: "standard",
  BUSINESS: "business",
  ENTERPRISE: "enterprise",
});

const ReleaseStatus = Object.freeze({
  DRAFT: "draft",
  READY: "ready",
  RUNNING: "running",
  PAUSED: "paused",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  ROLLED_BACK: "rolled_back",
  CANCELLED: "cancelled",
});

const StageStatus = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
  SKIPPED: "skipped",
  ROLLED_BACK: "rolled_back",
});

const DeploymentStatus = Object.freeze({
  QUEUED: "queued",
  APPLYING: "applying",
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  FAILED: "failed",
  REVERTED: "reverted",
});

const FlagKind = Object.freeze({
  BOOLEAN: "boolean",
  STRING: "string",
  NUMBER: "number",
  JSON: "json",
});

const RuleKind = Object.freeze({
  TENANT_LIST: "tenant_list",
  ATTRIBUTE_MATCH: "attribute_match",
  PERCENTAGE: "percentage",
  DEFAULT: "default",
});

const Comparator = Object.freeze({
  EQUALS: "equals",
  NOT_EQUALS: "not_equals",
  IN: "in",
  CONTAINS: "contains",
  GREATER_THAN: "greater_than",
});

const SloWindow = Object.freeze({
  FIVE_MINUTES: "5m",
  THIRTY_MINUTES: "30m",
  ONE_HOUR: "1h",
  ONE_DAY: "1d",
});

const MetricKind = Object.freeze({
  AVAILABILITY: "availability",
  ERROR_RATE: "error_rate",
  LATENCY_P95: "latency_p95",
  SATURATION: "saturation",
});

const AlertSeverity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
});

const AuditAction = Object.freeze({
  TENANT_CREATED: "tenant.created",
  FLAG_CREATED: "flag.created",
  FLAG_UPDATED: "flag.updated",
  FLAG_EVALUATED: "flag.evaluated",
  RELEASE_PLANNED: "release.planned",
  RELEASE_APPROVED: "release.approved",
  RELEASE_STARTED: "release.started",
  STAGE_STARTED: "release.stage_started",
  STAGE_PROMOTED: "release.stage_promoted",
  RELEASE_PAUSED: "release.paused",
  RELEASE_RESUMED: "release.resumed",
  RELEASE_FAILED: "release.failed",
  RELEASE_ROLLED_BACK: "release.rolled_back",
  ALERT_OPENED: "alert.opened",
  ALERT_RESOLVED: "alert.resolved",
});

const DEFAULT_CONTROL_PLANE_POLICY = Object.freeze({
  approvalQuorum: 2,
  maximumParallelRegions: 2,
  maximumCanaryPercent: 20,
  minimumObservationMinutes: 10,
  automaticRollback: true,
  requireChangeTicket: true,
  allowedProductionHoursUtc: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]),
});

const DEFAULT_SLO_THRESHOLDS = Object.freeze({
  availability: 99.9,
  errorRate: 0.01,
  latencyP95Ms: 450,
  saturation: 0.85,
});

class FleetError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.retryable = Boolean(options.retryable);
  }
}

class ValidationError extends FleetError {
  constructor(message, issues) {
    super("VALIDATION_FAILED", message, { issues });
    this.issues = Object.freeze([...issues]);
  }
}

class NotFoundError extends FleetError {
  constructor(resource, identifier) {
    super(
      "RESOURCE_NOT_FOUND",
      resource + " was not found",
      { resource, identifier },
    );
  }
}

class ConflictError extends FleetError {
  constructor(resource, identifier, expectedVersion, actualVersion) {
    super(
      "VERSION_CONFLICT",
      resource + " changed while the operation was in progress",
      {
        resource,
        identifier,
        expectedVersion,
        actualVersion,
      },
      { retryable: true },
    );
  }
}

class PolicyViolationError extends FleetError {
  constructor(policy, message, context = {}) {
    super("POLICY_VIOLATION", message, { policy, ...context });
  }
}

class HealthGateError extends FleetError {
  constructor(releaseId, stageId, violations) {
    super(
      "HEALTH_GATE_FAILED",
      "Release health gate rejected promotion",
      { releaseId, stageId, violations },
    );
  }
}

class AdapterError extends FleetError {
  constructor(adapter, operation, cause, retryable = true) {
    super(
      "ADAPTER_FAILURE",
      adapter + " failed during " + operation,
      {
        adapter,
        operation,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
      { cause, retryable },
    );
  }
}

function deepClone(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function freezeRecord(value) {
  return Object.freeze(deepClone(value));
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function groupBy(values, keySelector) {
  const groups = new Map();

  for (const value of values) {
    const key = keySelector(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }

  return groups;
}

function omitUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }

  const keys = Object.keys(value).sort();
  const fields = keys.map((key) => {
    return JSON.stringify(key) + ":" + stableStringify(value[key]);
  });

  return "{" + fields.join(",") + "}";
}

function deterministicHash(input) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function percentageBucket(seed) {
  return deterministicHash(seed) % 10000;
}

function redactSecrets(record) {
  const secretNames = new Set([
    "authorization",
    "token",
    "secret",
    "password",
    "apiKey",
  ]);

  function visit(value, key = "") {
    if (secretNames.has(key)) {
      return "[REDACTED]";
    }

    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => {
          return [childKey, visit(childValue, childKey)];
        }),
      );
    }

    return value;
  }

  return visit(record);
}

function getPath(record, path) {
  return path
    .split(".")
    .filter(Boolean)
    .reduce((value, segment) => {
      if (value === null || value === undefined) {
        return undefined;
      }

      return value[segment];
    }, record);
}

function compareValues(actual, comparator, expected) {
  switch (comparator) {
    case Comparator.EQUALS:
      return actual === expected;
    case Comparator.NOT_EQUALS:
      return actual !== expected;
    case Comparator.IN:
      return Array.isArray(expected) && expected.includes(actual);
    case Comparator.CONTAINS:
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual).includes(String(expected));
    case Comparator.GREATER_THAN:
      return Number(actual) > Number(expected);
    default:
      return false;
  }
}

class ValidationContext {
  constructor(subject) {
    this.subject = subject;
    this.issues = [];
  }

  issue(path, code, message, actual) {
    this.issues.push(
      omitUndefined({
        path,
        code,
        message,
        actual,
      }),
    );

    return this;
  }

  required(path, value) {
    if (value === undefined || value === null || value === "") {
      this.issue(path, "required", path + " is required", value);
    }

    return this;
  }

  string(path, value, options = {}) {
    if (value === undefined && options.optional) {
      return this;
    }

    if (typeof value !== "string") {
      return this.issue(path, "type", path + " must be a string", value);
    }

    if (options.minimum && value.length < options.minimum) {
      this.issue(
        path,
        "minimum_length",
        path + " must contain at least " + options.minimum + " characters",
        value,
      );
    }

    if (options.maximum && value.length > options.maximum) {
      this.issue(
        path,
        "maximum_length",
        path + " must contain no more than " + options.maximum + " characters",
        value,
      );
    }

    if (options.pattern && !options.pattern.test(value)) {
      this.issue(path, "pattern", path + " has an invalid format", value);
    }

    return this;
  }

  number(path, value, options = {}) {
    if (value === undefined && options.optional) {
      return this;
    }

    if (typeof value !== "number" || Number.isNaN(value)) {
      return this.issue(path, "type", path + " must be a number", value);
    }

    if (options.integer && !Number.isInteger(value)) {
      this.issue(path, "integer", path + " must be an integer", value);
    }

    if (options.minimum !== undefined && value < options.minimum) {
      this.issue(
        path,
        "minimum",
        path + " must be at least " + options.minimum,
        value,
      );
    }

    if (options.maximum !== undefined && value > options.maximum) {
      this.issue(
        path,
        "maximum",
        path + " must be no more than " + options.maximum,
        value,
      );
    }

    return this;
  }

  boolean(path, value, options = {}) {
    if (value === undefined && options.optional) {
      return this;
    }

    if (typeof value !== "boolean") {
      this.issue(path, "type", path + " must be a boolean", value);
    }

    return this;
  }

  array(path, value, options = {}) {
    if (value === undefined && options.optional) {
      return this;
    }

    if (!Array.isArray(value)) {
      return this.issue(path, "type", path + " must be an array", value);
    }

    if (options.minimum !== undefined && value.length < options.minimum) {
      this.issue(
        path,
        "minimum_items",
        path + " must contain at least " + options.minimum + " items",
        value,
      );
    }

    if (options.maximum !== undefined && value.length > options.maximum) {
      this.issue(
        path,
        "maximum_items",
        path + " must contain no more than " + options.maximum + " items",
        value,
      );
    }

    return this;
  }

  oneOf(path, value, allowed) {
    if (!Object.values(allowed).includes(value)) {
      this.issue(
        path,
        "choice",
        path + " must be one of: " + Object.values(allowed).join(", "),
        value,
      );
    }

    return this;
  }

  identifier(path, value) {
    return this.string(path, value, {
      minimum: 3,
      maximum: 80,
      pattern: /^[a-z][a-z0-9-]*$/,
    });
  }

  isoTimestamp(path, value, options = {}) {
    if (value === undefined && options.optional) {
      return this;
    }

    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      this.issue(path, "timestamp", path + " must be an ISO timestamp", value);
    }

    return this;
  }

  finish() {
    if (this.issues.length > 0) {
      throw new ValidationError(
        "Invalid " + this.subject,
        this.issues,
      );
    }

    return true;
  }
}

function validateTenant(input) {
  const validation = new ValidationContext("tenant");

  validation
    .identifier("id", input.id)
    .string("displayName", input.displayName, { minimum: 2, maximum: 120 })
    .oneOf("tier", input.tier, TenantTier)
    .array("regions", input.regions, { minimum: 1, maximum: 12 })
    .array("owners", input.owners, { minimum: 1, maximum: 20 });

  for (const [index, region] of (input.regions ?? []).entries()) {
    validation.identifier("regions[" + index + "]", region);
  }

  for (const [index, owner] of (input.owners ?? []).entries()) {
    validation.string("owners[" + index + "]", owner, {
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    });
  }

  validation.finish();

  return freezeRecord({
    id: input.id,
    displayName: input.displayName,
    tier: input.tier,
    regions: sortedUnique(input.regions),
    owners: sortedUnique(input.owners),
    labels: { ...(input.labels ?? {}) },
    version: input.version ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function validateService(input) {
  const validation = new ValidationContext("service");

  validation
    .identifier("id", input.id)
    .string("name", input.name, { minimum: 2, maximum: 100 })
    .identifier("ownerTeam", input.ownerTeam)
    .array("supportedRegions", input.supportedRegions, {
      minimum: 1,
      maximum: 24,
    })
    .string("repositoryUrl", input.repositoryUrl, {
      pattern: /^https:\/\/.+/,
    });

  validation.finish();

  return freezeRecord({
    id: input.id,
    name: input.name,
    ownerTeam: input.ownerTeam,
    repositoryUrl: input.repositoryUrl,
    supportedRegions: sortedUnique(input.supportedRegions),
    criticality: input.criticality ?? "medium",
    labels: { ...(input.labels ?? {}) },
    version: input.version ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function validateArtifact(input) {
  const validation = new ValidationContext("release artifact");

  validation
    .identifier("serviceId", input.serviceId)
    .string("version", input.version, {
      pattern: /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/,
    })
    .string("digest", input.digest, {
      pattern: /^sha256:[a-f0-9]{64}$/,
    })
    .string("sourceRevision", input.sourceRevision, {
      pattern: /^[a-f0-9]{7,40}$/,
    });

  validation.finish();

  return freezeRecord({
    serviceId: input.serviceId,
    version: input.version,
    digest: input.digest,
    sourceRevision: input.sourceRevision,
    provenance: deepClone(input.provenance ?? {}),
    builtAt: input.builtAt,
  });
}

function validateTarget(input) {
  const validation = new ValidationContext("deployment target");

  validation
    .identifier("tenantId", input.tenantId)
    .identifier("serviceId", input.serviceId)
    .identifier("region", input.region)
    .oneOf("environment", input.environment, EnvironmentKind);

  validation.finish();

  return freezeRecord({
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    region: input.region,
    environment: input.environment,
    cluster: input.cluster ?? input.region + "-primary",
  });
}

function validateFlagValue(kind, value, path, validation) {
  switch (kind) {
    case FlagKind.BOOLEAN:
      validation.boolean(path, value);
      break;
    case FlagKind.STRING:
      validation.string(path, value);
      break;
    case FlagKind.NUMBER:
      validation.number(path, value);
      break;
    case FlagKind.JSON:
      if (value === null || typeof value !== "object") {
        validation.issue(path, "type", path + " must be JSON-compatible", value);
      }
      break;
    default:
      validation.issue(path, "kind", "Unknown feature flag kind", kind);
  }
}

function validateFlagRule(rule, index, kind, validation) {
  const prefix = "rules[" + index + "]";

  validation
    .string(prefix + ".id", rule.id, { minimum: 2, maximum: 80 })
    .oneOf(prefix + ".kind", rule.kind, RuleKind)
    .number(prefix + ".priority", rule.priority, {
      integer: true,
      minimum: 0,
      maximum: 10000,
    });

  validateFlagValue(kind, rule.value, prefix + ".value", validation);

  if (rule.kind === RuleKind.TENANT_LIST) {
    validation.array(prefix + ".tenantIds", rule.tenantIds, { minimum: 1 });
  }

  if (rule.kind === RuleKind.ATTRIBUTE_MATCH) {
    validation
      .string(prefix + ".attribute", rule.attribute, { minimum: 1 })
      .oneOf(prefix + ".comparator", rule.comparator, Comparator);
  }

  if (rule.kind === RuleKind.PERCENTAGE) {
    validation.number(prefix + ".percentage", rule.percentage, {
      minimum: 0,
      maximum: 100,
    });
  }
}

function validateFeatureFlag(input) {
  const validation = new ValidationContext("feature flag");

  validation
    .identifier("key", input.key)
    .string("description", input.description, { minimum: 4, maximum: 240 })
    .oneOf("kind", input.kind, FlagKind)
    .array("rules", input.rules, { maximum: 100 })
    .boolean("enabled", input.enabled);

  validateFlagValue(input.kind, input.defaultValue, "defaultValue", validation);

  for (const [index, rule] of (input.rules ?? []).entries()) {
    validateFlagRule(rule, index, input.kind, validation);
  }

  const defaultRules = (input.rules ?? []).filter((rule) => {
    return rule.kind === RuleKind.DEFAULT;
  });

  if (defaultRules.length > 1) {
    validation.issue(
      "rules",
      "duplicate_default",
      "A feature flag can contain at most one default rule",
    );
  }

  validation.finish();

  return freezeRecord({
    key: input.key,
    description: input.description,
    kind: input.kind,
    enabled: input.enabled,
    defaultValue: deepClone(input.defaultValue),
    rules: [...input.rules]
      .sort((left, right) => left.priority - right.priority)
      .map((rule) => deepClone(rule)),
    labels: { ...(input.labels ?? {}) },
    version: input.version ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function validateSloDefinition(input) {
  const validation = new ValidationContext("SLO definition");

  validation
    .identifier("id", input.id)
    .identifier("serviceId", input.serviceId)
    .oneOf("metric", input.metric, MetricKind)
    .oneOf("window", input.window, SloWindow)
    .number("target", input.target)
    .number("warningBurnRate", input.warningBurnRate, { minimum: 0 })
    .number("criticalBurnRate", input.criticalBurnRate, {
      minimum: input.warningBurnRate,
    });

  validation.finish();

  return freezeRecord({
    id: input.id,
    serviceId: input.serviceId,
    metric: input.metric,
    window: input.window,
    target: input.target,
    warningBurnRate: input.warningBurnRate,
    criticalBurnRate: input.criticalBurnRate,
    tenantId: input.tenantId ?? null,
    version: input.version ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function validateRolloutStage(input, index) {
  const validation = new ValidationContext("rollout stage");

  validation
    .string("id", input.id, { minimum: 2, maximum: 80 })
    .number("percentage", input.percentage, {
      minimum: 0.01,
      maximum: 100,
    })
    .number("observationMinutes", input.observationMinutes, {
      integer: true,
      minimum: 1,
      maximum: 1440,
    })
    .array("regions", input.regions, { minimum: 1 })
    .array("requiredSloIds", input.requiredSloIds, { minimum: 1 });

  validation.finish();

  return freezeRecord({
    id: input.id,
    order: index,
    name: input.name ?? input.id,
    percentage: input.percentage,
    observationMinutes: input.observationMinutes,
    regions: sortedUnique(input.regions),
    requiredSloIds: sortedUnique(input.requiredSloIds),
    status: input.status ?? StageStatus.PENDING,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    healthReport: deepClone(input.healthReport ?? null),
    deploymentIds: [...(input.deploymentIds ?? [])],
  });
}

function validateReleasePlan(input) {
  const validation = new ValidationContext("release plan");

  validation
    .identifier("id", input.id)
    .identifier("serviceId", input.serviceId)
    .oneOf("environment", input.environment, EnvironmentKind)
    .array("tenantIds", input.tenantIds, { minimum: 1 })
    .array("stages", input.stages, { minimum: 1, maximum: 12 })
    .array("approvals", input.approvals, { maximum: 12 })
    .string("changeTicket", input.changeTicket, {
      optional: !input.policy?.requireChangeTicket,
      pattern: /^[A-Z]+-\d+$/,
    });

  const artifact = validateArtifact(input.artifact);
  const stages = input.stages.map((stage, index) => {
    return validateRolloutStage(stage, index);
  });

  const percentages = stages.map((stage) => stage.percentage);

  for (let index = 1; index < percentages.length; index += 1) {
    if (percentages[index] <= percentages[index - 1]) {
      validation.issue(
        "stages[" + index + "].percentage",
        "monotonic",
        "Stage percentages must increase strictly",
        percentages[index],
      );
    }
  }

  if (percentages.at(-1) !== 100) {
    validation.issue(
      "stages",
      "final_percentage",
      "The final rollout stage must target 100 percent",
      percentages.at(-1),
    );
  }

  validation.finish();

  return freezeRecord({
    id: input.id,
    serviceId: input.serviceId,
    artifact,
    environment: input.environment,
    tenantIds: sortedUnique(input.tenantIds),
    stages,
    approvals: sortedUnique(input.approvals),
    changeTicket: input.changeTicket ?? null,
    reason: input.reason ?? "",
    policy: {
      ...DEFAULT_CONTROL_PLANE_POLICY,
      ...(input.policy ?? {}),
    },
    status: input.status ?? ReleaseStatus.DRAFT,
    activeStageIndex: input.activeStageIndex ?? null,
    previousArtifact: deepClone(input.previousArtifact ?? null),
    version: input.version ?? 0,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  });
}

function validateAuditEvent(input) {
  const validation = new ValidationContext("audit event");

  validation
    .string("id", input.id, { minimum: 4 })
    .string("actor", input.actor, { minimum: 3 })
    .string("action", input.action, { minimum: 3 })
    .string("resourceType", input.resourceType, { minimum: 2 })
    .string("resourceId", input.resourceId, { minimum: 2 })
    .isoTimestamp("occurredAt", input.occurredAt);

  validation.finish();

  return freezeRecord({
    id: input.id,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    tenantId: input.tenantId ?? null,
    traceId: input.traceId ?? null,
    occurredAt: input.occurredAt,
    metadata: redactSecrets(input.metadata ?? {}),
  });
}

class SystemClock {
  now() {
    return new Date().toISOString();
  }
}

class ManualClock {
  constructor(initialTimestamp) {
    this.current = new Date(initialTimestamp);
  }

  now() {
    return this.current.toISOString();
  }

  advanceMilliseconds(milliseconds) {
    this.current = new Date(this.current.getTime() + milliseconds);
    return this.now();
  }

  advanceMinutes(minutes) {
    return this.advanceMilliseconds(minutes * 60 * 1000);
  }
}

class IncrementingIdGenerator {
  constructor(prefix = "id") {
    this.prefix = prefix;
    this.sequence = 0;
  }

  next(kind = this.prefix) {
    this.sequence += 1;
    return kind + "-" + String(this.sequence).padStart(6, "0");
  }
}

class InMemoryEntityRepository {
  constructor(resourceName, keyField, clock) {
    this.resourceName = resourceName;
    this.keyField = keyField;
    this.clock = clock;
    this.records = new Map();
  }

  keyOf(entity) {
    return entity[this.keyField];
  }

  has(identifier) {
    return this.records.has(identifier);
  }

  get(identifier) {
    const record = this.records.get(identifier);
    return record ? freezeRecord(record) : null;
  }

  require(identifier) {
    const record = this.get(identifier);

    if (!record) {
      throw new NotFoundError(this.resourceName, identifier);
    }

    return record;
  }

  list(predicate = () => true) {
    return [...this.records.values()]
      .filter(predicate)
      .map((record) => freezeRecord(record));
  }

  save(entity, options = {}) {
    const identifier = this.keyOf(entity);
    const existing = this.records.get(identifier);
    const actualVersion = existing?.version ?? 0;

    if (
      options.expectedVersion !== undefined
      && options.expectedVersion !== actualVersion
    ) {
      throw new ConflictError(
        this.resourceName,
        identifier,
        options.expectedVersion,
        actualVersion,
      );
    }

    const timestamp = this.clock.now();
    const stored = {
      ...deepClone(entity),
      version: actualVersion + 1,
      createdAt: existing?.createdAt ?? entity.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    this.records.set(identifier, stored);
    return freezeRecord(stored);
  }

  delete(identifier, options = {}) {
    const existing = this.records.get(identifier);

    if (!existing) {
      throw new NotFoundError(this.resourceName, identifier);
    }

    if (
      options.expectedVersion !== undefined
      && options.expectedVersion !== existing.version
    ) {
      throw new ConflictError(
        this.resourceName,
        identifier,
        options.expectedVersion,
        existing.version,
      );
    }

    this.records.delete(identifier);
    return freezeRecord(existing);
  }

  clear() {
    this.records.clear();
  }
}

class TenantRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("tenant", "id", clock);
  }

  listByRegion(region) {
    return this.list((tenant) => tenant.regions.includes(region));
  }

  listByTier(tier) {
    return this.list((tenant) => tenant.tier === tier);
  }
}

class ServiceRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("service", "id", clock);
  }

  listByOwnerTeam(ownerTeam) {
    return this.list((service) => service.ownerTeam === ownerTeam);
  }
}

class FeatureFlagRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("feature flag", "key", clock);
  }

  listEnabled() {
    return this.list((flag) => flag.enabled);
  }
}

class ReleaseRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("release", "id", clock);
  }

  listByService(serviceId) {
    return this.list((release) => release.serviceId === serviceId);
  }

  listActive() {
    const activeStatuses = new Set([
      ReleaseStatus.READY,
      ReleaseStatus.RUNNING,
      ReleaseStatus.PAUSED,
    ]);

    return this.list((release) => activeStatuses.has(release.status));
  }

  latestSucceeded(serviceId, environment) {
    return this
      .list((release) => {
        return (
          release.serviceId === serviceId
          && release.environment === environment
          && release.status === ReleaseStatus.SUCCEEDED
        );
      })
      .sort((left, right) => {
        return right.completedAt.localeCompare(left.completedAt);
      })
      .at(0) ?? null;
  }
}

class SloRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("SLO definition", "id", clock);
  }

  listByService(serviceId) {
    return this.list((slo) => slo.serviceId === serviceId);
  }
}

class AlertRepository extends InMemoryEntityRepository {
  constructor(clock) {
    super("alert", "id", clock);
  }

  listOpen() {
    return this.list((alert) => alert.status === "open");
  }

  findOpenByFingerprint(fingerprint) {
    return this.list((alert) => {
      return alert.status === "open" && alert.fingerprint === fingerprint;
    }).at(0) ?? null;
  }
}

class AuditEventRepository {
  constructor() {
    this.events = [];
    this.identifiers = new Set();
  }

  append(event) {
    if (this.identifiers.has(event.id)) {
      throw new ConflictError("audit event", event.id, 0, 1);
    }

    const validated = validateAuditEvent(event);
    this.events.push(deepClone(validated));
    this.identifiers.add(validated.id);
    return validated;
  }

  list(filter = {}) {
    return this.events
      .filter((event) => {
        if (filter.actor && event.actor !== filter.actor) {
          return false;
        }

        if (filter.action && event.action !== filter.action) {
          return false;
        }

        if (filter.resourceId && event.resourceId !== filter.resourceId) {
          return false;
        }

        if (filter.tenantId && event.tenantId !== filter.tenantId) {
          return false;
        }

        if (filter.since && event.occurredAt < filter.since) {
          return false;
        }

        return true;
      })
      .map((event) => freezeRecord(event));
  }

  verifyChain() {
    const identifiers = new Set();

    for (const event of this.events) {
      if (identifiers.has(event.id)) {
        return false;
      }

      identifiers.add(event.id);
    }

    return true;
  }
}

class StructuredLogger {
  constructor(clock, sink = []) {
    this.clock = clock;
    this.sink = sink;
    this.context = {};
  }

  child(context) {
    const logger = new StructuredLogger(this.clock, this.sink);
    logger.context = {
      ...this.context,
      ...context,
    };
    return logger;
  }

  write(level, message, fields = {}) {
    const entry = freezeRecord({
      timestamp: this.clock.now(),
      level,
      message,
      ...this.context,
      ...redactSecrets(fields),
    });

    this.sink.push(entry);
    return entry;
  }

  debug(message, fields) {
    return this.write("debug", message, fields);
  }

  info(message, fields) {
    return this.write("info", message, fields);
  }

  warn(message, fields) {
    return this.write("warn", message, fields);
  }

  error(message, fields) {
    return this.write("error", message, fields);
  }

  entries(filter = {}) {
    return this.sink
      .filter((entry) => {
        if (filter.level && entry.level !== filter.level) {
          return false;
        }

        if (filter.traceId && entry.traceId !== filter.traceId) {
          return false;
        }

        if (filter.message && !entry.message.includes(filter.message)) {
          return false;
        }

        return true;
      })
      .map((entry) => freezeRecord(entry));
  }
}

class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }

  serializeLabels(labels = {}) {
    return Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => key + "=" + value)
      .join(",");
  }

  metricKey(name, labels) {
    const serialized = this.serializeLabels(labels);
    return serialized ? name + "{" + serialized + "}" : name;
  }

  increment(name, amount = 1, labels = {}) {
    const key = this.metricKey(name, labels);
    const next = (this.counters.get(key) ?? 0) + amount;
    this.counters.set(key, next);
    return next;
  }

  setGauge(name, value, labels = {}) {
    const key = this.metricKey(name, labels);
    this.gauges.set(key, value);
    return value;
  }

  observe(name, value, labels = {}) {
    const key = this.metricKey(name, labels);
    const observations = this.histograms.get(key) ?? [];
    observations.push(value);
    this.histograms.set(key, observations);
    return observations.length;
  }

  counter(name, labels = {}) {
    return this.counters.get(this.metricKey(name, labels)) ?? 0;
  }

  gauge(name, labels = {}) {
    return this.gauges.get(this.metricKey(name, labels)) ?? null;
  }

  histogram(name, labels = {}) {
    const values = this.histograms.get(this.metricKey(name, labels)) ?? [];

    return freezeRecord({
      count: values.length,
      minimum: values.length > 0 ? Math.min(...values) : null,
      maximum: values.length > 0 ? Math.max(...values) : null,
      average: values.length > 0 ? round(average(values)) : null,
    });
  }

  snapshot() {
    return freezeRecord({
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms].map(([key, values]) => {
          return [
            key,
            {
              count: values.length,
              minimum: values.length > 0 ? Math.min(...values) : null,
              maximum: values.length > 0 ? Math.max(...values) : null,
              average: values.length > 0 ? round(average(values)) : null,
            },
          ];
        }),
      ),
    });
  }
}

class TraceSpan {
  constructor(input) {
    this.id = input.id;
    this.traceId = input.traceId;
    this.parentId = input.parentId ?? null;
    this.name = input.name;
    this.startedAt = input.startedAt;
    this.endedAt = null;
    this.status = "running";
    this.attributes = { ...(input.attributes ?? {}) };
    this.events = [];
    this.error = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
    return this;
  }

  addEvent(name, timestamp, attributes = {}) {
    this.events.push({
      name,
      timestamp,
      attributes: redactSecrets(attributes),
    });
    return this;
  }

  end(timestamp, status = "ok", error = null) {
    this.endedAt = timestamp;
    this.status = status;
    this.error = error
      ? {
          name: error.name,
          code: error.code,
          message: error.message,
        }
      : null;
    return this;
  }

  toRecord() {
    return freezeRecord({
      id: this.id,
      traceId: this.traceId,
      parentId: this.parentId,
      name: this.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.status,
      attributes: this.attributes,
      events: this.events,
      error: this.error,
    });
  }
}

class InMemoryTracer {
  constructor(clock, ids) {
    this.clock = clock;
    this.ids = ids;
    this.spans = [];
  }

  startSpan(name, attributes = {}, parent = null) {
    const span = new TraceSpan({
      id: this.ids.next("span"),
      traceId: parent?.traceId ?? this.ids.next("trace"),
      parentId: parent?.id ?? null,
      name,
      startedAt: this.clock.now(),
      attributes,
    });

    this.spans.push(span);
    return span;
  }

  async withSpan(name, attributes, operation, parent = null) {
    const span = this.startSpan(name, attributes, parent);

    try {
      const result = await operation(span);
      span.end(this.clock.now(), "ok");
      return result;
    } catch (error) {
      span.end(this.clock.now(), "error", error);
      throw error;
    }
  }

  list(filter = {}) {
    return this.spans
      .filter((span) => {
        if (filter.traceId && span.traceId !== filter.traceId) {
          return false;
        }

        if (filter.name && span.name !== filter.name) {
          return false;
        }

        if (filter.status && span.status !== filter.status) {
          return false;
        }

        return true;
      })
      .map((span) => span.toRecord());
  }
}

class InMemoryEventBus {
  constructor(logger) {
    this.logger = logger;
    this.handlers = new Map();
    this.published = [];
  }

  subscribe(eventType, handler) {
    const handlers = this.handlers.get(eventType) ?? [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);

    return () => {
      const current = this.handlers.get(eventType) ?? [];
      this.handlers.set(
        eventType,
        current.filter((candidate) => candidate !== handler),
      );
    };
  }

  async publish(eventType, payload) {
    const envelope = freezeRecord({
      type: eventType,
      payload,
    });

    this.published.push(envelope);

    for (const handler of this.handlers.get(eventType) ?? []) {
      try {
        await handler(envelope);
      } catch (error) {
        this.logger.error("Event subscriber failed", {
          eventType,
          error: error.message,
        });
      }
    }

    return envelope;
  }

  list(eventType = null) {
    return this.published
      .filter((event) => eventType === null || event.type === eventType)
      .map((event) => freezeRecord(event));
  }
}

class InMemoryTelemetryAdapter {
  constructor(clock) {
    this.clock = clock;
    this.samples = [];
  }

  record(sample) {
    const validation = new ValidationContext("telemetry sample");

    validation
      .identifier("serviceId", sample.serviceId)
      .identifier("tenantId", sample.tenantId)
      .identifier("region", sample.region)
      .oneOf("metric", sample.metric, MetricKind)
      .number("value", sample.value)
      .isoTimestamp("recordedAt", sample.recordedAt ?? this.clock.now());

    validation.finish();

    const stored = freezeRecord({
      serviceId: sample.serviceId,
      tenantId: sample.tenantId,
      region: sample.region,
      metric: sample.metric,
      value: sample.value,
      releaseId: sample.releaseId ?? null,
      recordedAt: sample.recordedAt ?? this.clock.now(),
    });

    this.samples.push(stored);
    return stored;
  }

  query(filter) {
    return this.samples
      .filter((sample) => {
        if (filter.serviceId && sample.serviceId !== filter.serviceId) {
          return false;
        }

        if (filter.tenantId && sample.tenantId !== filter.tenantId) {
          return false;
        }

        if (filter.region && sample.region !== filter.region) {
          return false;
        }

        if (filter.metric && sample.metric !== filter.metric) {
          return false;
        }

        if (filter.releaseId && sample.releaseId !== filter.releaseId) {
          return false;
        }

        if (filter.since && sample.recordedAt < filter.since) {
          return false;
        }

        return true;
      })
      .map((sample) => freezeRecord(sample));
  }

  aggregate(filter) {
    const samples = this.query(filter);
    const values = samples.map((sample) => sample.value);

    return freezeRecord({
      count: values.length,
      average: values.length > 0 ? round(average(values), 6) : null,
      minimum: values.length > 0 ? Math.min(...values) : null,
      maximum: values.length > 0 ? Math.max(...values) : null,
      latest: samples.at(-1) ?? null,
    });
  }
}

class SimulatedDeploymentAdapter {
  constructor(clock, ids, logger) {
    this.clock = clock;
    this.ids = ids;
    this.logger = logger;
    this.deployments = new Map();
    this.failures = [];
  }

  injectFailure(match, message, retryable = true) {
    this.failures.push({
      match,
      message,
      retryable,
      consumed: false,
    });
  }

  findFailure(target, artifact) {
    return this.failures.find((failure) => {
      if (failure.consumed) {
        return false;
      }

      return Object.entries(failure.match).every(([key, value]) => {
        return target[key] === value || artifact[key] === value;
      });
    });
  }

  async deploy(target, artifact, rollout) {
    const failure = this.findFailure(target, artifact);

    if (failure) {
      failure.consumed = true;
      throw new AdapterError(
        "simulated-deployer",
        "deploy",
        new Error(failure.message),
        failure.retryable,
      );
    }

    const deployment = {
      id: this.ids.next("deployment"),
      target: deepClone(target),
      artifact: deepClone(artifact),
      rollout: deepClone(rollout),
      status: DeploymentStatus.APPLYING,
      previousArtifact: this.currentArtifact(target),
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
    };

    this.deployments.set(deployment.id, deployment);

    deployment.status = DeploymentStatus.HEALTHY;
    deployment.updatedAt = this.clock.now();

    this.logger.info("Deployment became healthy", {
      deploymentId: deployment.id,
      tenantId: target.tenantId,
      serviceId: target.serviceId,
      region: target.region,
      version: artifact.version,
      percentage: rollout.percentage,
    });

    return freezeRecord(deployment);
  }

  async rollback(deploymentId, reason) {
    const deployment = this.deployments.get(deploymentId);

    if (!deployment) {
      throw new NotFoundError("deployment", deploymentId);
    }

    deployment.status = DeploymentStatus.REVERTED;
    deployment.rollbackReason = reason;
    deployment.updatedAt = this.clock.now();

    this.logger.warn("Deployment reverted", {
      deploymentId,
      reason,
      restoredVersion: deployment.previousArtifact?.version ?? null,
    });

    return freezeRecord(deployment);
  }

  async inspect(deploymentId) {
    const deployment = this.deployments.get(deploymentId);

    if (!deployment) {
      throw new NotFoundError("deployment", deploymentId);
    }

    return freezeRecord(deployment);
  }

  list(filter = {}) {
    return [...this.deployments.values()]
      .filter((deployment) => {
        const target = deployment.target;

        if (filter.releaseId && deployment.rollout.releaseId !== filter.releaseId) {
          return false;
        }

        if (filter.tenantId && target.tenantId !== filter.tenantId) {
          return false;
        }

        if (filter.serviceId && target.serviceId !== filter.serviceId) {
          return false;
        }

        if (filter.status && deployment.status !== filter.status) {
          return false;
        }

        return true;
      })
      .map((deployment) => freezeRecord(deployment));
  }

  currentArtifact(target) {
    return [...this.deployments.values()]
      .filter((deployment) => {
        return (
          deployment.target.tenantId === target.tenantId
          && deployment.target.serviceId === target.serviceId
          && deployment.target.region === target.region
          && deployment.target.environment === target.environment
          && deployment.status === DeploymentStatus.HEALTHY
        );
      })
      .sort((left, right) => {
        return right.updatedAt.localeCompare(left.updatedAt);
      })
      .at(0)?.artifact ?? null;
  }
}

class AuditService {
  constructor(repository, clock, ids, eventBus) {
    this.repository = repository;
    this.clock = clock;
    this.ids = ids;
    this.eventBus = eventBus;
  }

  async record(input) {
    const event = this.repository.append({
      id: this.ids.next("audit"),
      actor: input.actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      tenantId: input.tenantId ?? null,
      traceId: input.traceId ?? null,
      occurredAt: this.clock.now(),
      metadata: input.metadata ?? {},
    });

    await this.eventBus.publish("audit.recorded", event);
    return event;
  }

  history(resourceId) {
    return this.repository.list({ resourceId });
  }
}

class TenantService {
  constructor(tenants, audit, tracer, logger) {
    this.tenants = tenants;
    this.audit = audit;
    this.tracer = tracer;
    this.logger = logger;
  }

  async create(input, actor) {
    return this.tracer.withSpan(
      "tenant.create",
      { tenantId: input.id, actor },
      async (span) => {
        if (this.tenants.has(input.id)) {
          throw new ConflictError("tenant", input.id, 0, 1);
        }

        const tenant = this.tenants.save(validateTenant(input));

        await this.audit.record({
          actor,
          action: AuditAction.TENANT_CREATED,
          resourceType: "tenant",
          resourceId: tenant.id,
          tenantId: tenant.id,
          traceId: span.traceId,
          metadata: {
            tier: tenant.tier,
            regions: tenant.regions,
          },
        });

        this.logger.info("Tenant registered", {
          traceId: span.traceId,
          tenantId: tenant.id,
          tier: tenant.tier,
        });

        return tenant;
      },
    );
  }

  requireAll(tenantIds) {
    return sortedUnique(tenantIds).map((tenantId) => {
      return this.tenants.require(tenantId);
    });
  }
}

class FeatureFlagService {
  constructor(flags, audit, tracer, metrics, logger) {
    this.flags = flags;
    this.audit = audit;
    this.tracer = tracer;
    this.metrics = metrics;
    this.logger = logger;
  }

  async create(input, actor) {
    return this.tracer.withSpan(
      "feature-flag.create",
      { flagKey: input.key, actor },
      async (span) => {
        if (this.flags.has(input.key)) {
          throw new ConflictError("feature flag", input.key, 0, 1);
        }

        const flag = this.flags.save(validateFeatureFlag(input));

        await this.audit.record({
          actor,
          action: AuditAction.FLAG_CREATED,
          resourceType: "feature_flag",
          resourceId: flag.key,
          traceId: span.traceId,
          metadata: {
            enabled: flag.enabled,
            kind: flag.kind,
            ruleCount: flag.rules.length,
          },
        });

        return flag;
      },
    );
  }

  async update(key, patch, expectedVersion, actor) {
    return this.tracer.withSpan(
      "feature-flag.update",
      { flagKey: key, actor },
      async (span) => {
        const current = this.flags.require(key);
        const candidate = validateFeatureFlag({
          ...current,
          ...deepClone(patch),
          key,
          version: current.version,
        });

        const saved = this.flags.save(candidate, { expectedVersion });

        await this.audit.record({
          actor,
          action: AuditAction.FLAG_UPDATED,
          resourceType: "feature_flag",
          resourceId: saved.key,
          traceId: span.traceId,
          metadata: {
            previousVersion: current.version,
            nextVersion: saved.version,
            changedFields: Object.keys(patch).sort(),
          },
        });

        return saved;
      },
    );
  }

  matchRule(rule, context) {
    switch (rule.kind) {
      case RuleKind.TENANT_LIST:
        return rule.tenantIds.includes(context.tenantId);
      case RuleKind.ATTRIBUTE_MATCH:
        return compareValues(
          getPath(context, rule.attribute),
          rule.comparator,
          rule.expected,
        );
      case RuleKind.PERCENTAGE: {
        const seed = [
          context.tenantId,
          context.subjectKey ?? "anonymous",
          context.flagKey,
          rule.id,
        ].join(":");
        const threshold = clamp(rule.percentage, 0, 100) * 100;
        return percentageBucket(seed) < threshold;
      }
      case RuleKind.DEFAULT:
        return true;
      default:
        return false;
    }
  }

  evaluate(key, context) {
    const flag = this.flags.require(key);
    const evaluationContext = {
      ...context,
      flagKey: key,
    };

    let value = flag.defaultValue;
    let reason = "default_value";
    let ruleId = null;

    if (!flag.enabled) {
      reason = "flag_disabled";
    } else {
      const matched = flag.rules.find((rule) => {
        return this.matchRule(rule, evaluationContext);
      });

      if (matched) {
        value = deepClone(matched.value);
        reason = "rule_match";
        ruleId = matched.id;
      }
    }

    this.metrics.increment("fleet_flag_evaluations_total", 1, {
      flag: key,
      reason,
    });

    this.logger.debug("Feature flag evaluated", {
      flagKey: key,
      tenantId: context.tenantId,
      ruleId,
      reason,
    });

    return freezeRecord({
      key,
      value,
      reason,
      ruleId,
      version: flag.version,
    });
  }
}

class SloEvaluationService {
  constructor(slos, telemetry, clock, metrics) {
    this.slos = slos;
    this.telemetry = telemetry;
    this.clock = clock;
    this.metrics = metrics;
  }

  windowMilliseconds(window) {
    const windows = {
      [SloWindow.FIVE_MINUTES]: 5 * 60 * 1000,
      [SloWindow.THIRTY_MINUTES]: 30 * 60 * 1000,
      [SloWindow.ONE_HOUR]: 60 * 60 * 1000,
      [SloWindow.ONE_DAY]: 24 * 60 * 60 * 1000,
    };

    return windows[window];
  }

  isHealthy(definition, observedValue) {
    if (observedValue === null) {
      return false;
    }

    switch (definition.metric) {
      case MetricKind.AVAILABILITY:
        return observedValue >= definition.target;
      case MetricKind.ERROR_RATE:
      case MetricKind.LATENCY_P95:
      case MetricKind.SATURATION:
        return observedValue <= definition.target;
      default:
        return false;
    }
  }

  burnRate(definition, observedValue) {
    if (observedValue === null) {
      return Number.POSITIVE_INFINITY;
    }

    if (definition.metric === MetricKind.AVAILABILITY) {
      const allowedFailure = Math.max(100 - definition.target, 0.000001);
      const observedFailure = Math.max(100 - observedValue, 0);
      return observedFailure / allowedFailure;
    }

    if (definition.target === 0) {
      return observedValue === 0 ? 0 : Number.POSITIVE_INFINITY;
    }

    return observedValue / definition.target;
  }

  evaluate(sloId, filter = {}) {
    const definition = this.slos.require(sloId);
    const since = new Date(
      Date.parse(this.clock.now()) - this.windowMilliseconds(definition.window),
    ).toISOString();

    const aggregate = this.telemetry.aggregate({
      serviceId: definition.serviceId,
      tenantId: definition.tenantId ?? filter.tenantId,
      region: filter.region,
      releaseId: filter.releaseId,
      metric: definition.metric,
      since,
    });

    const observedValue = aggregate.average;
    const burnRate = this.burnRate(definition, observedValue);
    const healthy = this.isHealthy(definition, observedValue);
    const severity = burnRate >= definition.criticalBurnRate
      ? AlertSeverity.CRITICAL
      : burnRate >= definition.warningBurnRate
        ? AlertSeverity.WARNING
        : AlertSeverity.INFO;

    this.metrics.setGauge("fleet_slo_burn_rate", burnRate, {
      slo: definition.id,
      service: definition.serviceId,
    });

    return freezeRecord({
      sloId: definition.id,
      serviceId: definition.serviceId,
      metric: definition.metric,
      window: definition.window,
      target: definition.target,
      sampleCount: aggregate.count,
      observedValue,
      healthy,
      burnRate: Number.isFinite(burnRate) ? round(burnRate, 4) : null,
      severity,
      evaluatedAt: this.clock.now(),
    });
  }

  evaluateMany(sloIds, filter = {}) {
    const results = sortedUnique(sloIds).map((sloId) => {
      return this.evaluate(sloId, filter);
    });

    return freezeRecord({
      healthy: results.every((result) => result.healthy),
      violations: results.filter((result) => !result.healthy),
      results,
      evaluatedAt: this.clock.now(),
    });
  }
}

class AlertService {
  constructor(alerts, audit, clock, ids, eventBus, logger) {
    this.alerts = alerts;
    this.audit = audit;
    this.clock = clock;
    this.ids = ids;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  fingerprint(evaluation, context) {
    return deterministicHash(
      [
        evaluation.sloId,
        context.releaseId ?? "steady-state",
        context.tenantId ?? "all-tenants",
        context.region ?? "all-regions",
      ].join(":"),
    ).toString(16);
  }

  async reconcile(evaluation, context, actor = "system:slo-monitor") {
    const fingerprint = this.fingerprint(evaluation, context);
    const existing = this.alerts.findOpenByFingerprint(fingerprint);

    if (!evaluation.healthy && !existing) {
      const alert = this.alerts.save({
        id: this.ids.next("alert"),
        fingerprint,
        status: "open",
        severity: evaluation.severity,
        sloId: evaluation.sloId,
        serviceId: evaluation.serviceId,
        releaseId: context.releaseId ?? null,
        tenantId: context.tenantId ?? null,
        region: context.region ?? null,
        openedAt: this.clock.now(),
        resolvedAt: null,
        latestEvaluation: evaluation,
      });

      await this.audit.record({
        actor,
        action: AuditAction.ALERT_OPENED,
        resourceType: "alert",
        resourceId: alert.id,
        tenantId: alert.tenantId,
        metadata: {
          severity: alert.severity,
          sloId: alert.sloId,
          releaseId: alert.releaseId,
        },
      });

      await this.eventBus.publish("alert.opened", alert);
      this.logger.warn("SLO alert opened", {
        alertId: alert.id,
        severity: alert.severity,
        sloId: alert.sloId,
      });

      return alert;
    }

    if (evaluation.healthy && existing) {
      const resolved = this.alerts.save(
        {
          ...existing,
          status: "resolved",
          resolvedAt: this.clock.now(),
          latestEvaluation: evaluation,
        },
        { expectedVersion: existing.version },
      );

      await this.audit.record({
        actor,
        action: AuditAction.ALERT_RESOLVED,
        resourceType: "alert",
        resourceId: resolved.id,
        tenantId: resolved.tenantId,
        metadata: {
          sloId: resolved.sloId,
          releaseId: resolved.releaseId,
        },
      });

      await this.eventBus.publish("alert.resolved", resolved);
      return resolved;
    }

    if (!evaluation.healthy && existing) {
      return this.alerts.save(
        {
          ...existing,
          severity: evaluation.severity,
          latestEvaluation: evaluation,
        },
        { expectedVersion: existing.version },
      );
    }

    return null;
  }
}

class ReleasePolicyService {
  constructor(clock) {
    this.clock = clock;
  }

  approvalActors(release) {
    return sortedUnique(
      release.approvals.map((approval) => {
        return typeof approval === "string" ? approval : approval.actor;
      }),
    );
  }

  evaluate(release) {
    const violations = [];
    const policy = {
      ...DEFAULT_CONTROL_PLANE_POLICY,
      ...release.policy,
    };
    const approvals = this.approvalActors(release);

    if (approvals.length < policy.approvalQuorum) {
      violations.push({
        policy: "approval_quorum",
        expected: policy.approvalQuorum,
        actual: approvals.length,
      });
    }

    if (policy.requireChangeTicket && !release.changeTicket) {
      violations.push({
        policy: "change_ticket",
        expected: "a linked change ticket",
        actual: null,
      });
    }

    const firstStage = release.stages[0];

    if (
      release.environment === EnvironmentKind.PRODUCTION
      && firstStage.percentage > policy.maximumCanaryPercent
    ) {
      violations.push({
        policy: "maximum_canary_percentage",
        expected: policy.maximumCanaryPercent,
        actual: firstStage.percentage,
      });
    }

    for (const stage of release.stages) {
      if (stage.observationMinutes < policy.minimumObservationMinutes) {
        violations.push({
          policy: "minimum_observation_minutes",
          stageId: stage.id,
          expected: policy.minimumObservationMinutes,
          actual: stage.observationMinutes,
        });
      }
    }

    if (release.environment === EnvironmentKind.PRODUCTION) {
      const hour = new Date(this.clock.now()).getUTCHours();

      if (!policy.allowedProductionHoursUtc.includes(hour)) {
        violations.push({
          policy: "production_change_window",
          expected: policy.allowedProductionHoursUtc,
          actual: hour,
        });
      }
    }

    return freezeRecord({
      allowed: violations.length === 0,
      violations,
      evaluatedAt: this.clock.now(),
    });
  }

  enforce(release) {
    const evaluation = this.evaluate(release);

    if (!evaluation.allowed) {
      throw new PolicyViolationError(
        "release_readiness",
        "Release does not satisfy control-plane policy",
        { violations: evaluation.violations },
      );
    }

    return evaluation;
  }
}

class ReleasePlanningService {
  constructor(dependencies) {
    this.releases = dependencies.releases;
    this.services = dependencies.services;
    this.tenants = dependencies.tenants;
    this.slos = dependencies.slos;
    this.audit = dependencies.audit;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
    this.tracer = dependencies.tracer;
    this.logger = dependencies.logger;
    this.policy = dependencies.policy;
  }

  validateRelationships(input) {
    const service = this.services.require(input.serviceId);
    const tenants = sortedUnique(input.tenantIds).map((tenantId) => {
      return this.tenants.require(tenantId);
    });
    const requiredSloIds = sortedUnique(
      input.stages.flatMap((stage) => stage.requiredSloIds),
    );
    const slos = requiredSloIds.map((sloId) => this.slos.require(sloId));

    for (const slo of slos) {
      if (slo.serviceId !== service.id) {
        throw new PolicyViolationError(
          "slo_service_alignment",
          "Release stage references an SLO for another service",
          {
            serviceId: service.id,
            sloId: slo.id,
            sloServiceId: slo.serviceId,
          },
        );
      }
    }

    for (const tenant of tenants) {
      const unsupported = tenant.regions.filter((region) => {
        return !service.supportedRegions.includes(region);
      });

      if (unsupported.length > 0) {
        throw new PolicyViolationError(
          "regional_support",
          "Service does not support every tenant region",
          {
            tenantId: tenant.id,
            serviceId: service.id,
            unsupportedRegions: unsupported,
          },
        );
      }
    }

    return { service, tenants, slos };
  }

  async plan(input, actor) {
    return this.tracer.withSpan(
      "release.plan",
      {
        serviceId: input.serviceId,
        environment: input.environment,
        actor,
      },
      async (span) => {
        this.validateRelationships(input);

        const releaseId = input.id ?? this.ids.next("release");
        const previous = this.releases.latestSucceeded(
          input.serviceId,
          input.environment,
        );
        const candidate = validateReleasePlan({
          ...input,
          id: releaseId,
          approvals: input.approvals ?? [],
          status: ReleaseStatus.DRAFT,
          previousArtifact: previous?.artifact ?? input.previousArtifact ?? null,
          createdBy: actor,
          createdAt: this.clock.now(),
        });
        const saved = this.releases.save(candidate);

        await this.audit.record({
          actor,
          action: AuditAction.RELEASE_PLANNED,
          resourceType: "release",
          resourceId: saved.id,
          traceId: span.traceId,
          metadata: {
            serviceId: saved.serviceId,
            version: saved.artifact.version,
            tenantCount: saved.tenantIds.length,
            stageCount: saved.stages.length,
          },
        });

        this.logger.info("Release plan created", {
          traceId: span.traceId,
          releaseId: saved.id,
          serviceId: saved.serviceId,
          version: saved.artifact.version,
        });

        return saved;
      },
    );
  }

  async approve(releaseId, actor) {
    return this.tracer.withSpan(
      "release.approve",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);

        if (release.status !== ReleaseStatus.DRAFT) {
          throw new PolicyViolationError(
            "approval_state",
            "Only draft releases can receive approval",
            { releaseId, status: release.status },
          );
        }

        if (release.createdBy === actor) {
          throw new PolicyViolationError(
            "separation_of_duties",
            "The release author cannot approve the same release",
            { releaseId, actor },
          );
        }

        const approvals = sortedUnique([...release.approvals, actor]);
        let status = ReleaseStatus.DRAFT;
        const candidate = {
          ...release,
          approvals,
        };

        if (approvals.length >= release.policy.approvalQuorum) {
          this.policy.enforce(candidate);
          status = ReleaseStatus.READY;
        }

        const saved = this.releases.save(
          { ...candidate, status },
          { expectedVersion: release.version },
        );

        await this.audit.record({
          actor,
          action: AuditAction.RELEASE_APPROVED,
          resourceType: "release",
          resourceId: saved.id,
          traceId: span.traceId,
          metadata: {
            approvalCount: saved.approvals.length,
            status: saved.status,
          },
        });

        return saved;
      },
    );
  }
}

class RolloutOrchestrator {
  constructor(dependencies) {
    this.releases = dependencies.releases;
    this.tenants = dependencies.tenants;
    this.deployer = dependencies.deployer;
    this.sloEvaluator = dependencies.sloEvaluator;
    this.alerts = dependencies.alerts;
    this.audit = dependencies.audit;
    this.clock = dependencies.clock;
    this.tracer = dependencies.tracer;
    this.metrics = dependencies.metrics;
    this.logger = dependencies.logger;
    this.eventBus = dependencies.eventBus;
  }

  activeStage(release) {
    if (release.activeStageIndex === null) {
      return null;
    }

    return release.stages[release.activeStageIndex] ?? null;
  }

  updateStage(release, stageIndex, patch) {
    const stages = release.stages.map((stage, index) => {
      return index === stageIndex
        ? {
            ...stage,
            ...deepClone(patch),
          }
        : stage;
    });

    return {
      ...release,
      stages,
    };
  }

  selectTenantTargets(release, stage) {
    const selected = [];
    const threshold = Math.round(stage.percentage * 100);

    for (const tenantId of release.tenantIds) {
      const tenant = this.tenants.require(tenantId);

      for (const region of tenant.regions) {
        if (!stage.regions.includes(region)) {
          continue;
        }

        const bucket = percentageBucket(
          [release.id, stage.id, tenantId, region].join(":"),
        );

        if (stage.percentage === 100 || bucket < threshold) {
          selected.push(
            validateTarget({
              tenantId,
              serviceId: release.serviceId,
              region,
              environment: release.environment,
            }),
          );
        }
      }
    }

    if (selected.length === 0 && release.tenantIds.length > 0) {
      const firstTenant = this.tenants.require(release.tenantIds[0]);
      const firstRegion = firstTenant.regions.find((region) => {
        return stage.regions.includes(region);
      });

      if (firstRegion) {
        selected.push(
          validateTarget({
            tenantId: firstTenant.id,
            serviceId: release.serviceId,
            region: firstRegion,
            environment: release.environment,
          }),
        );
      }
    }

    return selected;
  }

  async deployStage(release, stageIndex, span) {
    const stage = release.stages[stageIndex];
    const targets = this.selectTenantTargets(release, stage);
    const deployments = [];

    span.addEvent("targets.selected", this.clock.now(), {
      stageId: stage.id,
      targetCount: targets.length,
    });

    for (const target of targets) {
      const deployment = await this.deployer.deploy(
        target,
        release.artifact,
        {
          releaseId: release.id,
          stageId: stage.id,
          percentage: stage.percentage,
        },
      );
      deployments.push(deployment);
    }

    this.metrics.increment(
      "fleet_deployments_total",
      deployments.length,
      {
        service: release.serviceId,
        stage: stage.id,
      },
    );

    return deployments;
  }

  async start(releaseId, actor) {
    return this.tracer.withSpan(
      "release.start",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);

        if (release.status !== ReleaseStatus.READY) {
          throw new PolicyViolationError(
            "release_start_state",
            "Only a ready release can start",
            { releaseId, status: release.status },
          );
        }

        const running = this.releases.save(
          {
            ...release,
            status: ReleaseStatus.RUNNING,
            activeStageIndex: 0,
            startedAt: this.clock.now(),
          },
          { expectedVersion: release.version },
        );

        await this.audit.record({
          actor,
          action: AuditAction.RELEASE_STARTED,
          resourceType: "release",
          resourceId: running.id,
          traceId: span.traceId,
          metadata: {
            serviceId: running.serviceId,
            version: running.artifact.version,
          },
        });

        await this.eventBus.publish("release.started", running);
        return this.startCurrentStage(running.id, actor, span);
      },
    );
  }

  async startCurrentStage(releaseId, actor, parentSpan = null) {
    return this.tracer.withSpan(
      "release.stage.start",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);

        if (release.status !== ReleaseStatus.RUNNING) {
          throw new PolicyViolationError(
            "stage_start_state",
            "Release must be running before a stage can start",
            { releaseId, status: release.status },
          );
        }

        const stageIndex = release.activeStageIndex;
        const stage = release.stages[stageIndex];

        if (!stage || stage.status !== StageStatus.PENDING) {
          throw new PolicyViolationError(
            "stage_pending_state",
            "Active stage must be pending",
            {
              releaseId,
              stageIndex,
              stageStatus: stage?.status ?? null,
            },
          );
        }

        const withRunningStage = this.updateStage(release, stageIndex, {
          status: StageStatus.RUNNING,
          startedAt: this.clock.now(),
        });
        const staged = this.releases.save(
          withRunningStage,
          { expectedVersion: release.version },
        );

        await this.audit.record({
          actor,
          action: AuditAction.STAGE_STARTED,
          resourceType: "release",
          resourceId: staged.id,
          traceId: span.traceId,
          metadata: {
            stageId: stage.id,
            percentage: stage.percentage,
            regions: stage.regions,
          },
        });

        try {
          const deployments = await this.deployStage(staged, stageIndex, span);
          const latest = this.releases.require(releaseId);
          const withDeploymentIds = this.updateStage(latest, stageIndex, {
            deploymentIds: deployments.map((deployment) => deployment.id),
          });

          return this.releases.save(
            withDeploymentIds,
            { expectedVersion: latest.version },
          );
        } catch (error) {
          await this.fail(releaseId, actor, error, span.traceId);
          throw error;
        }
      },
      parentSpan,
    );
  }

  async evaluateCurrentStage(releaseId, actor = "system:rollout-monitor") {
    return this.tracer.withSpan(
      "release.stage.evaluate",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);
        const stage = this.activeStage(release);

        if (release.status !== ReleaseStatus.RUNNING || !stage) {
          throw new PolicyViolationError(
            "stage_evaluation_state",
            "A running release with an active stage is required",
            { releaseId, status: release.status },
          );
        }

        const startedAt = Date.parse(stage.startedAt);
        const elapsedMinutes = (Date.parse(this.clock.now()) - startedAt) / 60000;

        if (elapsedMinutes < stage.observationMinutes) {
          return freezeRecord({
            ready: false,
            reason: "observation_window",
            elapsedMinutes: round(elapsedMinutes, 2),
            requiredMinutes: stage.observationMinutes,
          });
        }

        const report = this.sloEvaluator.evaluateMany(stage.requiredSloIds, {
          releaseId,
        });

        for (const evaluation of report.results) {
          await this.alerts.reconcile(evaluation, { releaseId });
        }

        const latest = this.releases.require(releaseId);
        const stagePatch = {
          status: report.healthy
            ? StageStatus.HEALTHY
            : StageStatus.UNHEALTHY,
          healthReport: report,
          completedAt: this.clock.now(),
        };
        const evaluated = this.releases.save(
          this.updateStage(
            latest,
            latest.activeStageIndex,
            stagePatch,
          ),
          { expectedVersion: latest.version },
        );

        span.setAttribute("healthy", report.healthy);
        span.setAttribute("violationCount", report.violations.length);

        if (!report.healthy) {
          this.metrics.increment("fleet_health_gate_failures_total", 1, {
            service: release.serviceId,
            stage: stage.id,
          });
        }

        return freezeRecord({
          ready: true,
          release: evaluated,
          report,
        });
      },
    );
  }

  async promote(releaseId, actor) {
    return this.tracer.withSpan(
      "release.stage.promote",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);
        const stage = this.activeStage(release);

        if (!stage || stage.status !== StageStatus.HEALTHY) {
          throw new HealthGateError(
            releaseId,
            stage?.id ?? "none",
            stage?.healthReport?.violations ?? [
              { reason: "stage_not_healthy" },
            ],
          );
        }

        const nextIndex = release.activeStageIndex + 1;
        const isComplete = nextIndex >= release.stages.length;
        const promoted = this.releases.save(
          {
            ...release,
            status: isComplete
              ? ReleaseStatus.SUCCEEDED
              : ReleaseStatus.RUNNING,
            activeStageIndex: isComplete ? null : nextIndex,
            completedAt: isComplete ? this.clock.now() : null,
          },
          { expectedVersion: release.version },
        );

        await this.audit.record({
          actor,
          action: AuditAction.STAGE_PROMOTED,
          resourceType: "release",
          resourceId: promoted.id,
          traceId: span.traceId,
          metadata: {
            completedStageId: stage.id,
            nextStageId: isComplete
              ? null
              : promoted.stages[nextIndex].id,
            releaseComplete: isComplete,
          },
        });

        this.metrics.increment("fleet_stage_promotions_total", 1, {
          service: release.serviceId,
          stage: stage.id,
        });

        if (isComplete) {
          await this.eventBus.publish("release.succeeded", promoted);
          return promoted;
        }

        return this.startCurrentStage(promoted.id, actor, span);
      },
    );
  }

  async pause(releaseId, actor, reason) {
    const release = this.releases.require(releaseId);

    if (release.status !== ReleaseStatus.RUNNING) {
      throw new PolicyViolationError(
        "pause_state",
        "Only a running release can be paused",
        { releaseId, status: release.status },
      );
    }

    const paused = this.releases.save(
      {
        ...release,
        status: ReleaseStatus.PAUSED,
      },
      { expectedVersion: release.version },
    );

    await this.audit.record({
      actor,
      action: AuditAction.RELEASE_PAUSED,
      resourceType: "release",
      resourceId: paused.id,
      metadata: { reason },
    });

    this.logger.warn("Release paused", {
      releaseId,
      actor,
      reason,
    });

    return paused;
  }

  async resume(releaseId, actor) {
    const release = this.releases.require(releaseId);

    if (release.status !== ReleaseStatus.PAUSED) {
      throw new PolicyViolationError(
        "resume_state",
        "Only a paused release can be resumed",
        { releaseId, status: release.status },
      );
    }

    const resumed = this.releases.save(
      {
        ...release,
        status: ReleaseStatus.RUNNING,
      },
      { expectedVersion: release.version },
    );

    await this.audit.record({
      actor,
      action: AuditAction.RELEASE_RESUMED,
      resourceType: "release",
      resourceId: resumed.id,
      metadata: {
        activeStageId: this.activeStage(resumed)?.id ?? null,
      },
    });

    return resumed;
  }

  async fail(releaseId, actor, error, traceId = null) {
    const release = this.releases.require(releaseId);
    const stageIndex = release.activeStageIndex;
    const withFailedStage = stageIndex === null
      ? release
      : this.updateStage(release, stageIndex, {
          status: StageStatus.UNHEALTHY,
          completedAt: this.clock.now(),
          healthReport: {
            healthy: false,
            violations: [
              {
                code: error.code ?? "UNKNOWN",
                message: error.message,
              },
            ],
          },
        });
    const failed = this.releases.save(
      {
        ...withFailedStage,
        status: ReleaseStatus.FAILED,
        completedAt: this.clock.now(),
      },
      { expectedVersion: release.version },
    );

    await this.audit.record({
      actor,
      action: AuditAction.RELEASE_FAILED,
      resourceType: "release",
      resourceId: failed.id,
      traceId,
      metadata: {
        errorCode: error.code ?? "UNKNOWN",
        message: error.message,
      },
    });

    await this.eventBus.publish("release.failed", failed);
    return failed;
  }
}

class RollbackService {
  constructor(dependencies) {
    this.releases = dependencies.releases;
    this.deployer = dependencies.deployer;
    this.audit = dependencies.audit;
    this.clock = dependencies.clock;
    this.tracer = dependencies.tracer;
    this.metrics = dependencies.metrics;
    this.logger = dependencies.logger;
    this.eventBus = dependencies.eventBus;
  }

  rollbackCandidate(release) {
    if (!release.previousArtifact) {
      throw new PolicyViolationError(
        "rollback_artifact",
        "No previous artifact is available for rollback",
        { releaseId: release.id },
      );
    }

    return release.previousArtifact;
  }

  async execute(releaseId, actor, reason) {
    return this.tracer.withSpan(
      "release.rollback",
      { releaseId, actor },
      async (span) => {
        const release = this.releases.require(releaseId);
        this.rollbackCandidate(release);

        if (
          release.status === ReleaseStatus.ROLLED_BACK
          || release.status === ReleaseStatus.CANCELLED
        ) {
          throw new PolicyViolationError(
            "rollback_state",
            "Release cannot be rolled back from its current state",
            { releaseId, status: release.status },
          );
        }

        const deployments = this.deployer.list({ releaseId });
        const reverted = [];
        const failures = [];

        for (const deployment of deployments) {
          if (deployment.status === DeploymentStatus.REVERTED) {
            continue;
          }

          try {
            reverted.push(
              await this.deployer.rollback(deployment.id, reason),
            );
          } catch (error) {
            failures.push({
              deploymentId: deployment.id,
              code: error.code ?? "UNKNOWN",
              message: error.message,
            });
          }
        }

        if (failures.length > 0) {
          throw new AdapterError(
            "simulated-deployer",
            "rollback",
            new Error(stableStringify(failures)),
            true,
          );
        }

        const stages = release.stages.map((stage) => {
          if (stage.deploymentIds.length === 0) {
            return stage;
          }

          return {
            ...stage,
            status: StageStatus.ROLLED_BACK,
          };
        });
        const rolledBack = this.releases.save(
          {
            ...release,
            stages,
            status: ReleaseStatus.ROLLED_BACK,
            completedAt: this.clock.now(),
          },
          { expectedVersion: release.version },
        );

        await this.audit.record({
          actor,
          action: AuditAction.RELEASE_ROLLED_BACK,
          resourceType: "release",
          resourceId: rolledBack.id,
          traceId: span.traceId,
          metadata: {
            reason,
            deploymentCount: reverted.length,
            restoredVersion: release.previousArtifact.version,
          },
        });

        this.metrics.increment("fleet_rollbacks_total", 1, {
          service: release.serviceId,
          environment: release.environment,
        });

        this.logger.warn("Release rolled back", {
          traceId: span.traceId,
          releaseId,
          reason,
          deploymentCount: reverted.length,
        });

        await this.eventBus.publish("release.rolled_back", rolledBack);
        return rolledBack;
      },
    );
  }
}

class FleetControlPlane {
  constructor(options = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new IncrementingIdGenerator("fleet");
    this.metrics = options.metrics ?? new MetricsRegistry();
    this.logger = options.logger ?? new StructuredLogger(this.clock);
    this.tracer = options.tracer ?? new InMemoryTracer(this.clock, this.ids);
    this.eventBus = options.eventBus ?? new InMemoryEventBus(this.logger);
    this.telemetry = options.telemetry
      ?? new InMemoryTelemetryAdapter(this.clock);
    this.deployer = options.deployer
      ?? new SimulatedDeploymentAdapter(
        this.clock,
        this.ids,
        this.logger,
      );

    this.repositories = {
      tenants: new TenantRepository(this.clock),
      services: new ServiceRepository(this.clock),
      flags: new FeatureFlagRepository(this.clock),
      releases: new ReleaseRepository(this.clock),
      slos: new SloRepository(this.clock),
      alerts: new AlertRepository(this.clock),
      audits: new AuditEventRepository(),
    };

    this.audit = new AuditService(
      this.repositories.audits,
      this.clock,
      this.ids,
      this.eventBus,
    );
    this.tenants = new TenantService(
      this.repositories.tenants,
      this.audit,
      this.tracer,
      this.logger,
    );
    this.flags = new FeatureFlagService(
      this.repositories.flags,
      this.audit,
      this.tracer,
      this.metrics,
      this.logger,
    );
    this.sloEvaluator = new SloEvaluationService(
      this.repositories.slos,
      this.telemetry,
      this.clock,
      this.metrics,
    );
    this.alerts = new AlertService(
      this.repositories.alerts,
      this.audit,
      this.clock,
      this.ids,
      this.eventBus,
      this.logger,
    );
    this.releasePolicy = new ReleasePolicyService(this.clock);
    this.planner = new ReleasePlanningService({
      releases: this.repositories.releases,
      services: this.repositories.services,
      tenants: this.repositories.tenants,
      slos: this.repositories.slos,
      audit: this.audit,
      clock: this.clock,
      ids: this.ids,
      tracer: this.tracer,
      logger: this.logger,
      policy: this.releasePolicy,
    });
    this.rollouts = new RolloutOrchestrator({
      releases: this.repositories.releases,
      tenants: this.repositories.tenants,
      deployer: this.deployer,
      sloEvaluator: this.sloEvaluator,
      alerts: this.alerts,
      audit: this.audit,
      clock: this.clock,
      tracer: this.tracer,
      metrics: this.metrics,
      logger: this.logger,
      eventBus: this.eventBus,
    });
    this.rollbacks = new RollbackService({
      releases: this.repositories.releases,
      deployer: this.deployer,
      audit: this.audit,
      clock: this.clock,
      tracer: this.tracer,
      metrics: this.metrics,
      logger: this.logger,
      eventBus: this.eventBus,
    });

    this.installAutomaticRollback();
  }

  installAutomaticRollback() {
    this.eventBus.subscribe("release.failed", async (event) => {
      const release = event.payload;

      if (!release.policy.automaticRollback || !release.previousArtifact) {
        return;
      }

      try {
        await this.rollbacks.execute(
          release.id,
          "system:auto-rollback",
          "Automatic rollback after rollout failure",
        );
      } catch (error) {
        this.logger.error("Automatic rollback failed", {
          releaseId: release.id,
          errorCode: error.code,
          error: error.message,
        });
      }
    });
  }

  snapshot() {
    return freezeRecord({
      tenants: this.repositories.tenants.list(),
      services: this.repositories.services.list(),
      flags: this.repositories.flags.list(),
      releases: this.repositories.releases.list(),
      slos: this.repositories.slos.list(),
      alerts: this.repositories.alerts.list(),
      audits: this.repositories.audits.list(),
      deployments: this.deployer.list(),
      events: this.eventBus.list(),
      metrics: this.metrics.snapshot(),
      traces: this.tracer.list(),
    });
  }
}

const DEMO_ACTORS = Object.freeze({
  AUTHOR: "engineer:mina",
  APPROVER_ONE: "approver:reliability",
  APPROVER_TWO: "approver:security",
  INCIDENT_COMMANDER: "oncall:incident-commander",
});

const DEMO_ARTIFACTS = Object.freeze({
  PREVIOUS: Object.freeze({
    serviceId: "gateway-api",
    version: "4.7.2",
    digest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceRevision: "71ee92a",
    provenance: {
      builder: "kiron-build-v3",
      signed: true,
      sbomDigest: "sha256:previous-sbom",
    },
    builtAt: "2026-08-11T14:22:00.000Z",
  }),
  CANDIDATE: Object.freeze({
    serviceId: "gateway-api",
    version: "4.8.0",
    digest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceRevision: "a849d3c",
    provenance: {
      builder: "kiron-build-v3",
      signed: true,
      sbomDigest: "sha256:candidate-sbom",
      policyAttestation: "slsa-level-3",
    },
    builtAt: "2026-08-12T02:30:00.000Z",
  }),
});

const DEMO_TENANTS = Object.freeze([
  Object.freeze({
    id: "aurora-labs",
    displayName: "Aurora Laboratories",
    tier: TenantTier.ENTERPRISE,
    regions: ["ap-northeast-2", "us-west-2"],
    owners: ["platform@aurora.example"],
    labels: {
      industry: "research",
      dataResidency: "mixed",
      releaseRing: "early",
    },
  }),
  Object.freeze({
    id: "cedar-bank",
    displayName: "Cedar Bank",
    tier: TenantTier.ENTERPRISE,
    regions: ["eu-central-1"],
    owners: ["sre@cedar.example", "security@cedar.example"],
    labels: {
      industry: "finance",
      dataResidency: "eu",
      releaseRing: "conservative",
    },
  }),
  Object.freeze({
    id: "northstar-health",
    displayName: "Northstar Health",
    tier: TenantTier.BUSINESS,
    regions: ["ap-northeast-2"],
    owners: ["operations@northstar.example"],
    labels: {
      industry: "healthcare",
      dataResidency: "apac",
      releaseRing: "standard",
    },
  }),
  Object.freeze({
    id: "paper-plane",
    displayName: "Paper Plane Studio",
    tier: TenantTier.STANDARD,
    regions: ["us-west-2"],
    owners: ["hello@paperplane.example"],
    labels: {
      industry: "creative",
      dataResidency: "us",
      releaseRing: "early",
    },
  }),
]);

const DEMO_SERVICE = Object.freeze({
  id: "gateway-api",
  name: "Fleet Gateway API",
  ownerTeam: "edge-platform",
  repositoryUrl: "https://example.invalid/kiron/gateway-api",
  supportedRegions: [
    "ap-northeast-2",
    "eu-central-1",
    "us-west-2",
  ],
  criticality: "critical",
  labels: {
    runtime: "node",
    protocol: "http",
    dataPlane: "true",
  },
});

const DEMO_SLOS = Object.freeze([
  Object.freeze({
    id: "gateway-availability",
    serviceId: "gateway-api",
    metric: MetricKind.AVAILABILITY,
    window: SloWindow.THIRTY_MINUTES,
    target: DEFAULT_SLO_THRESHOLDS.availability,
    warningBurnRate: 2,
    criticalBurnRate: 8,
  }),
  Object.freeze({
    id: "gateway-error-rate",
    serviceId: "gateway-api",
    metric: MetricKind.ERROR_RATE,
    window: SloWindow.FIVE_MINUTES,
    target: DEFAULT_SLO_THRESHOLDS.errorRate,
    warningBurnRate: 2,
    criticalBurnRate: 5,
  }),
  Object.freeze({
    id: "gateway-latency",
    serviceId: "gateway-api",
    metric: MetricKind.LATENCY_P95,
    window: SloWindow.THIRTY_MINUTES,
    target: DEFAULT_SLO_THRESHOLDS.latencyP95Ms,
    warningBurnRate: 1.2,
    criticalBurnRate: 2,
  }),
  Object.freeze({
    id: "gateway-saturation",
    serviceId: "gateway-api",
    metric: MetricKind.SATURATION,
    window: SloWindow.ONE_HOUR,
    target: DEFAULT_SLO_THRESHOLDS.saturation,
    warningBurnRate: 1.05,
    criticalBurnRate: 1.3,
  }),
]);

const DEMO_FLAGS = Object.freeze([
  Object.freeze({
    key: "adaptive-routing",
    description: "Selects the adaptive upstream routing strategy",
    kind: FlagKind.STRING,
    enabled: true,
    defaultValue: "static",
    rules: [
      {
        id: "aurora-preview",
        kind: RuleKind.TENANT_LIST,
        priority: 10,
        tenantIds: ["aurora-labs"],
        value: "adaptive-v2",
      },
      {
        id: "enterprise-ring",
        kind: RuleKind.ATTRIBUTE_MATCH,
        priority: 20,
        attribute: "tenant.tier",
        comparator: Comparator.EQUALS,
        expected: TenantTier.ENTERPRISE,
        value: "adaptive-v1",
      },
      {
        id: "general-canary",
        kind: RuleKind.PERCENTAGE,
        priority: 30,
        percentage: 15,
        value: "adaptive-v1",
      },
      {
        id: "static-default",
        kind: RuleKind.DEFAULT,
        priority: 1000,
        value: "static",
      },
    ],
    labels: {
      owner: "edge-platform",
      changeTicket: "FLEET-281",
    },
  }),
  Object.freeze({
    key: "audit-envelope-v2",
    description: "Emits the signed second-generation audit envelope",
    kind: FlagKind.BOOLEAN,
    enabled: true,
    defaultValue: false,
    rules: [
      {
        id: "finance-opt-in",
        kind: RuleKind.ATTRIBUTE_MATCH,
        priority: 10,
        attribute: "tenant.labels.industry",
        comparator: Comparator.EQUALS,
        expected: "finance",
        value: true,
      },
      {
        id: "twenty-five-percent",
        kind: RuleKind.PERCENTAGE,
        priority: 50,
        percentage: 25,
        value: true,
      },
    ],
    labels: {
      owner: "security-platform",
      risk: "low",
    },
  }),
]);

const DEMO_STAGES = Object.freeze([
  Object.freeze({
    id: "canary",
    name: "Regional canary",
    percentage: 10,
    observationMinutes: 10,
    regions: ["ap-northeast-2"],
    requiredSloIds: [
      "gateway-availability",
      "gateway-error-rate",
      "gateway-latency",
    ],
  }),
  Object.freeze({
    id: "regional",
    name: "Regional expansion",
    percentage: 50,
    observationMinutes: 20,
    regions: [
      "ap-northeast-2",
      "us-west-2",
    ],
    requiredSloIds: [
      "gateway-availability",
      "gateway-error-rate",
      "gateway-latency",
      "gateway-saturation",
    ],
  }),
  Object.freeze({
    id: "fleet",
    name: "Full fleet",
    percentage: 100,
    observationMinutes: 30,
    regions: [
      "ap-northeast-2",
      "eu-central-1",
      "us-west-2",
    ],
    requiredSloIds: [
      "gateway-availability",
      "gateway-error-rate",
      "gateway-latency",
      "gateway-saturation",
    ],
  }),
]);

function createDemoControlPlane() {
  const clock = new ManualClock("2026-08-12T03:00:00.000Z");
  const ids = new IncrementingIdGenerator("kiron");
  const logger = new StructuredLogger(clock);
  const controlPlane = new FleetControlPlane({
    clock,
    ids,
    logger,
  });

  return {
    clock,
    ids,
    logger,
    controlPlane,
  };
}

async function seedDemoControlPlane(fixture) {
  const { controlPlane } = fixture;

  for (const tenant of DEMO_TENANTS) {
    await controlPlane.tenants.create(tenant, "system:fixture-loader");
  }

  controlPlane.repositories.services.save(
    validateService(DEMO_SERVICE),
  );

  for (const definition of DEMO_SLOS) {
    controlPlane.repositories.slos.save(
      validateSloDefinition(definition),
    );
  }

  for (const flag of DEMO_FLAGS) {
    await controlPlane.flags.create(flag, "system:fixture-loader");
  }

  return fixture;
}

async function createApprovedDemoRelease(fixture, overrides = {}) {
  const { controlPlane } = fixture;
  const input = {
    serviceId: DEMO_SERVICE.id,
    artifact: DEMO_ARTIFACTS.CANDIDATE,
    previousArtifact: DEMO_ARTIFACTS.PREVIOUS,
    environment: EnvironmentKind.PRODUCTION,
    tenantIds: DEMO_TENANTS.map((tenant) => tenant.id),
    stages: DEMO_STAGES,
    approvals: [],
    changeTicket: "FLEET-281",
    reason: "Enable adaptive routing with safer timeout handling",
    policy: {
      ...DEFAULT_CONTROL_PLANE_POLICY,
      allowedProductionHoursUtc: [3, 4, 5],
    },
    ...deepClone(overrides),
  };
  let release = await controlPlane.planner.plan(
    input,
    DEMO_ACTORS.AUTHOR,
  );

  release = await controlPlane.planner.approve(
    release.id,
    DEMO_ACTORS.APPROVER_ONE,
  );
  release = await controlPlane.planner.approve(
    release.id,
    DEMO_ACTORS.APPROVER_TWO,
  );

  return release;
}

function recordHealthyTelemetry(fixture, releaseId, multiplier = 1) {
  const { controlPlane, clock } = fixture;
  const healthyValues = {
    [MetricKind.AVAILABILITY]: 99.99,
    [MetricKind.ERROR_RATE]: 0.002,
    [MetricKind.LATENCY_P95]: 240,
    [MetricKind.SATURATION]: 0.54,
  };

  for (const tenant of DEMO_TENANTS) {
    for (const region of tenant.regions) {
      for (const metric of Object.values(MetricKind)) {
        for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
          controlPlane.telemetry.record({
            serviceId: DEMO_SERVICE.id,
            tenantId: tenant.id,
            region,
            releaseId,
            metric,
            value: healthyValues[metric] * multiplier,
            recordedAt: clock.now(),
          });
        }
      }
    }
  }
}

function recordUnhealthyTelemetry(fixture, releaseId) {
  const { controlPlane, clock } = fixture;
  const unhealthyValues = {
    [MetricKind.AVAILABILITY]: 98.8,
    [MetricKind.ERROR_RATE]: 0.09,
    [MetricKind.LATENCY_P95]: 1100,
    [MetricKind.SATURATION]: 0.97,
  };

  for (const tenant of DEMO_TENANTS) {
    for (const region of tenant.regions) {
      for (const metric of Object.values(MetricKind)) {
        controlPlane.telemetry.record({
          serviceId: DEMO_SERVICE.id,
          tenantId: tenant.id,
          region,
          releaseId,
          metric,
          value: unhealthyValues[metric],
          recordedAt: clock.now(),
        });
      }
    }
  }
}

async function runHealthyReleaseScenario() {
  const fixture = await seedDemoControlPlane(createDemoControlPlane());
  const { controlPlane, clock } = fixture;
  let release = await createApprovedDemoRelease(fixture);

  release = await controlPlane.rollouts.start(
    release.id,
    DEMO_ACTORS.AUTHOR,
  );

  while (release.status === ReleaseStatus.RUNNING) {
    const stage = controlPlane.rollouts.activeStage(release);
    clock.advanceMinutes(stage.observationMinutes);
    recordHealthyTelemetry(fixture, release.id);

    const evaluation = await controlPlane.rollouts.evaluateCurrentStage(
      release.id,
    );

    if (!evaluation.report.healthy) {
      throw new HealthGateError(
        release.id,
        stage.id,
        evaluation.report.violations,
      );
    }

    release = await controlPlane.rollouts.promote(
      release.id,
      DEMO_ACTORS.AUTHOR,
    );
  }

  return {
    release,
    snapshot: controlPlane.snapshot(),
  };
}

class TestFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TestFailure";
    this.details = details;
  }
}

function assert(condition, message = "Expected condition to be true") {
  if (!condition) {
    throw new TestFailure(message);
  }
}

function assertEqual(actual, expected, message = "Values are not equal") {
  if (!Object.is(actual, expected)) {
    throw new TestFailure(message, {
      actual,
      expected,
    });
  }
}

function assertDeepEqual(
  actual,
  expected,
  message = "Structures are not equal",
) {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);

  if (actualJson !== expectedJson) {
    throw new TestFailure(message, {
      actual,
      expected,
    });
  }
}

function assertIncludes(collection, expected, message = "Value is missing") {
  if (!collection.includes(expected)) {
    throw new TestFailure(message, {
      collection,
      expected,
    });
  }
}

function assertMatches(value, pattern, message = "Value did not match") {
  if (!pattern.test(value)) {
    throw new TestFailure(message, {
      value,
      pattern: pattern.source,
    });
  }
}

async function assertRejects(
  operation,
  ErrorType,
  predicate = () => true,
) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof ErrorType)) {
      throw new TestFailure("Operation rejected with the wrong error type", {
        expected: ErrorType.name,
        actual: error.constructor.name,
        message: error.message,
      });
    }

    if (!predicate(error)) {
      throw new TestFailure("Rejected error did not satisfy predicate", {
        error,
      });
    }

    return error;
  }

  throw new TestFailure("Expected operation to reject");
}

class TestSuite {
  constructor(name, clock = new SystemClock()) {
    this.name = name;
    this.clock = clock;
    this.tests = [];
  }

  test(name, operation) {
    this.tests.push({ name, operation });
    return this;
  }

  async run() {
    const startedAt = Date.now();
    const results = [];

    for (const testCase of this.tests) {
      const testStartedAt = Date.now();

      try {
        await testCase.operation();
        results.push({
          name: testCase.name,
          status: "passed",
          durationMs: Date.now() - testStartedAt,
        });
      } catch (error) {
        results.push({
          name: testCase.name,
          status: "failed",
          durationMs: Date.now() - testStartedAt,
          error: {
            name: error.name,
            message: error.message,
            details: error.details,
          },
        });
      }
    }

    return freezeRecord({
      suite: this.name,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      durationMs: Date.now() - startedAt,
      finishedAt: this.clock.now(),
      results,
    });
  }
}

function buildUnitSuite() {
  const suite = new TestSuite("Kiron Fleet unit fixtures");

  suite.test("tenant validation normalizes regions and owners", () => {
    const tenant = validateTenant({
      id: "quiet-cloud",
      displayName: "Quiet Cloud",
      tier: TenantTier.BUSINESS,
      regions: ["us-west-2", "ap-northeast-2", "us-west-2"],
      owners: ["ops@quiet.example", "ops@quiet.example"],
    });

    assertDeepEqual(
      tenant.regions,
      ["ap-northeast-2", "us-west-2"],
    );
    assertDeepEqual(tenant.owners, ["ops@quiet.example"]);
    assert(Object.isFrozen(tenant));
  });

  suite.test("tenant validation reports structured issues", async () => {
    const error = await assertRejects(
      async () => {
        validateTenant({
          id: "UPPER_CASE",
          displayName: "",
          tier: "unknown",
          regions: [],
          owners: ["not-an-email"],
        });
      },
      ValidationError,
    );

    assert(error.issues.length >= 5);
    assert(
      error.issues.some((issue) => issue.path === "id"),
      "Expected an issue for the tenant identifier",
    );
  });

  suite.test("repository enforces optimistic concurrency", async () => {
    const clock = new ManualClock("2026-08-12T03:00:00.000Z");
    const repository = new TenantRepository(clock);
    const first = repository.save(validateTenant(DEMO_TENANTS[0]));
    const second = repository.save(
      {
        ...first,
        displayName: "Aurora Research",
      },
      { expectedVersion: first.version },
    );

    assertEqual(second.version, 2);

    await assertRejects(
      async () => {
        repository.save(
          {
            ...first,
            displayName: "Stale Update",
          },
          { expectedVersion: first.version },
        );
      },
      ConflictError,
      (error) => error.retryable,
    );
  });

  suite.test("percentage bucketing is stable", () => {
    const first = percentageBucket("aurora:subject-42:adaptive-routing");
    const second = percentageBucket("aurora:subject-42:adaptive-routing");
    const different = percentageBucket("cedar:subject-42:adaptive-routing");

    assertEqual(first, second);
    assert(first >= 0 && first < 10000);
    assert(
      first !== different,
      "Different tenants should normally occupy different buckets",
    );
  });

  suite.test("stable stringification ignores key insertion order", () => {
    const left = {
      tenant: "aurora",
      nested: {
        region: "ap-northeast-2",
        enabled: true,
      },
    };
    const right = {
      nested: {
        enabled: true,
        region: "ap-northeast-2",
      },
      tenant: "aurora",
    };

    assertEqual(stableStringify(left), stableStringify(right));
  });

  suite.test("secret redaction traverses arrays and objects", () => {
    const redacted = redactSecrets({
      token: "plain-text-token",
      request: {
        authorization: "Bearer private",
        headers: [
          {
            apiKey: "unsafe",
            name: "x-request-id",
          },
        ],
      },
    });

    assertEqual(redacted.token, "[REDACTED]");
    assertEqual(redacted.request.authorization, "[REDACTED]");
    assertEqual(redacted.request.headers[0].apiKey, "[REDACTED]");
    assertEqual(redacted.request.headers[0].name, "x-request-id");
  });

  suite.test("feature flag chooses a tenant override first", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const result = fixture.controlPlane.flags.evaluate(
      "adaptive-routing",
      {
        tenantId: "aurora-labs",
        subjectKey: "request-100",
        tenant: fixture.controlPlane.repositories.tenants.require(
          "aurora-labs",
        ),
      },
    );

    assertEqual(result.value, "adaptive-v2");
    assertEqual(result.ruleId, "aurora-preview");
  });

  suite.test("disabled flag returns its default value", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const current = fixture.controlPlane.repositories.flags.require(
      "audit-envelope-v2",
    );

    await fixture.controlPlane.flags.update(
      current.key,
      { enabled: false },
      current.version,
      DEMO_ACTORS.AUTHOR,
    );

    const result = fixture.controlPlane.flags.evaluate(
      current.key,
      {
        tenantId: "cedar-bank",
        subjectKey: "request-101",
        tenant: fixture.controlPlane.repositories.tenants.require(
          "cedar-bank",
        ),
      },
    );

    assertEqual(result.value, false);
    assertEqual(result.reason, "flag_disabled");
  });

  suite.test("metrics registry separates label sets", () => {
    const metrics = new MetricsRegistry();

    metrics.increment("requests", 2, { status: "ok" });
    metrics.increment("requests", 1, { status: "error" });
    metrics.observe("latency_ms", 40, { route: "/fleet" });
    metrics.observe("latency_ms", 60, { route: "/fleet" });

    assertEqual(metrics.counter("requests", { status: "ok" }), 2);
    assertEqual(metrics.counter("requests", { status: "error" }), 1);
    assertDeepEqual(
      metrics.histogram("latency_ms", { route: "/fleet" }),
      {
        count: 2,
        minimum: 40,
        maximum: 60,
        average: 50,
      },
    );
  });

  suite.test("audit repository is append only and unique", async () => {
    const repository = new AuditEventRepository();
    const event = {
      id: "audit-000001",
      actor: "system:test",
      action: AuditAction.FLAG_CREATED,
      resourceType: "feature_flag",
      resourceId: "adaptive-routing",
      occurredAt: "2026-08-12T03:00:00.000Z",
      metadata: {
        token: "secret-value",
      },
    };

    const appended = repository.append(event);

    assertEqual(appended.metadata.token, "[REDACTED]");
    assert(repository.verifyChain());

    await assertRejects(
      async () => repository.append(event),
      ConflictError,
    );
  });

  return suite;
}

function buildIntegrationSuite() {
  const suite = new TestSuite("Kiron Fleet integration fixtures");

  suite.test("release requires distinct approvals", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    let release = await fixture.controlPlane.planner.plan(
      {
        serviceId: DEMO_SERVICE.id,
        artifact: DEMO_ARTIFACTS.CANDIDATE,
        previousArtifact: DEMO_ARTIFACTS.PREVIOUS,
        environment: EnvironmentKind.PRODUCTION,
        tenantIds: ["aurora-labs"],
        stages: DEMO_STAGES,
        changeTicket: "FLEET-300",
        policy: {
          ...DEFAULT_CONTROL_PLANE_POLICY,
          allowedProductionHoursUtc: [3],
        },
      },
      DEMO_ACTORS.AUTHOR,
    );

    await assertRejects(
      async () => {
        return fixture.controlPlane.planner.approve(
          release.id,
          DEMO_ACTORS.AUTHOR,
        );
      },
      PolicyViolationError,
    );

    release = await fixture.controlPlane.planner.approve(
      release.id,
      DEMO_ACTORS.APPROVER_ONE,
    );

    assertEqual(release.status, ReleaseStatus.DRAFT);

    release = await fixture.controlPlane.planner.approve(
      release.id,
      DEMO_ACTORS.APPROVER_TWO,
    );

    assertEqual(release.status, ReleaseStatus.READY);
  });

  suite.test("healthy canary advances through the full fleet", async () => {
    const result = await runHealthyReleaseScenario();

    assertEqual(result.release.status, ReleaseStatus.SUCCEEDED);
    assertEqual(result.release.activeStageIndex, null);
    assert(
      result.release.stages.every((stage) => {
        return stage.status === StageStatus.HEALTHY;
      }),
    );
    assert(
      result.snapshot.deployments.length >= DEMO_TENANTS.length,
      "Expected multiple tenant deployments",
    );
    assertEqual(result.snapshot.alerts.length, 0);
  });

  suite.test("observation window blocks early evaluation", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const approved = await createApprovedDemoRelease(fixture);
    const running = await fixture.controlPlane.rollouts.start(
      approved.id,
      DEMO_ACTORS.AUTHOR,
    );
    recordHealthyTelemetry(fixture, running.id);

    const evaluation = await fixture.controlPlane.rollouts.evaluateCurrentStage(
      running.id,
    );

    assertEqual(evaluation.ready, false);
    assertEqual(evaluation.reason, "observation_window");
  });

  suite.test("unhealthy canary opens alerts and rejects promotion", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const approved = await createApprovedDemoRelease(fixture);
    const running = await fixture.controlPlane.rollouts.start(
      approved.id,
      DEMO_ACTORS.AUTHOR,
    );
    recordUnhealthyTelemetry(fixture, running.id);
    fixture.clock.advanceMinutes(10);

    const evaluation = await fixture.controlPlane.rollouts.evaluateCurrentStage(
      running.id,
    );

    assertEqual(evaluation.ready, true);
    assertEqual(evaluation.report.healthy, false);
    assert(
      fixture.controlPlane.repositories.alerts.listOpen().length >= 3,
      "Expected one alert for each violated SLO",
    );

    await assertRejects(
      async () => {
        return fixture.controlPlane.rollouts.promote(
          running.id,
          DEMO_ACTORS.AUTHOR,
        );
      },
      HealthGateError,
    );
  });

  suite.test("pause and resume preserve the active stage", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const approved = await createApprovedDemoRelease(fixture);
    const running = await fixture.controlPlane.rollouts.start(
      approved.id,
      DEMO_ACTORS.AUTHOR,
    );
    const stageId = fixture.controlPlane.rollouts.activeStage(running).id;
    const paused = await fixture.controlPlane.rollouts.pause(
      running.id,
      DEMO_ACTORS.INCIDENT_COMMANDER,
      "Investigating elevated regional queue depth",
    );

    assertEqual(paused.status, ReleaseStatus.PAUSED);

    const resumed = await fixture.controlPlane.rollouts.resume(
      running.id,
      DEMO_ACTORS.INCIDENT_COMMANDER,
    );

    assertEqual(resumed.status, ReleaseStatus.RUNNING);
    assertEqual(
      fixture.controlPlane.rollouts.activeStage(resumed).id,
      stageId,
    );
  });

  suite.test("manual rollback reverts release deployments", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const approved = await createApprovedDemoRelease(fixture);
    const running = await fixture.controlPlane.rollouts.start(
      approved.id,
      DEMO_ACTORS.AUTHOR,
    );
    const rolledBack = await fixture.controlPlane.rollbacks.execute(
      running.id,
      DEMO_ACTORS.INCIDENT_COMMANDER,
      "Operator observed incorrect upstream routing",
    );

    assertEqual(rolledBack.status, ReleaseStatus.ROLLED_BACK);

    const deployments = fixture.controlPlane.deployer.list({
      releaseId: running.id,
    });

    assert(
      deployments.every((deployment) => {
        return deployment.status === DeploymentStatus.REVERTED;
      }),
    );
    assertEqual(
      fixture.controlPlane.metrics.counter(
        "fleet_rollbacks_total",
        {
          service: DEMO_SERVICE.id,
          environment: EnvironmentKind.PRODUCTION,
        },
      ),
      1,
    );
  });

  suite.test("deployment adapter failure is traced and audited", async () => {
    const fixture = await seedDemoControlPlane(createDemoControlPlane());
    const approved = await createApprovedDemoRelease(fixture);

    fixture.controlPlane.deployer.injectFailure(
      {
        serviceId: DEMO_SERVICE.id,
      },
      "Synthetic cluster admission timeout",
    );

    await assertRejects(
      async () => {
        return fixture.controlPlane.rollouts.start(
          approved.id,
          DEMO_ACTORS.AUTHOR,
        );
      },
      AdapterError,
    );

    const release = fixture.controlPlane.repositories.releases.require(
      approved.id,
    );
    const auditActions = fixture.controlPlane.audit
      .history(approved.id)
      .map((event) => event.action);
    const failedSpans = fixture.controlPlane.tracer.list({
      status: "error",
    });

    assertIncludes(auditActions, AuditAction.RELEASE_FAILED);
    assert(failedSpans.length >= 1);
    assert(
      [ReleaseStatus.FAILED, ReleaseStatus.ROLLED_BACK].includes(
        release.status,
      ),
    );
  });

  suite.test("audit history captures the release lifecycle", async () => {
    const result = await runHealthyReleaseScenario();
    const history = result.snapshot.audits.filter((event) => {
      return event.resourceId === result.release.id;
    });
    const actions = history.map((event) => event.action);

    assertIncludes(actions, AuditAction.RELEASE_PLANNED);
    assertIncludes(actions, AuditAction.RELEASE_APPROVED);
    assertIncludes(actions, AuditAction.RELEASE_STARTED);
    assertIncludes(actions, AuditAction.STAGE_STARTED);
    assertIncludes(actions, AuditAction.STAGE_PROMOTED);
    assert(
      history.every((event) => event.occurredAt.endsWith("Z")),
      "Audit timestamps should use UTC",
    );
  });

  suite.test("control-plane snapshot contains observability evidence", async () => {
    const result = await runHealthyReleaseScenario();
    const snapshot = result.snapshot;

    assert(snapshot.traces.length > 0);
    assert(snapshot.events.length > 0);
    assert(
      Object.keys(snapshot.metrics.counters).some((name) => {
        return name.startsWith("fleet_deployments_total");
      }),
    );
    assert(
      snapshot.traces.every((span) => {
        return span.status === "ok" || span.status === "error";
      }),
    );
  });

  return suite;
}

async function runFleetTests() {
  const unit = await buildUnitSuite().run();
  const integration = await buildIntegrationSuite().run();
  const combined = freezeRecord({
    passed: unit.passed + integration.passed,
    failed: unit.failed + integration.failed,
    suites: [unit, integration],
  });

  if (combined.failed > 0) {
    const failures = combined.suites.flatMap((suite) => {
      return suite.results
        .filter((result) => result.status === "failed")
        .map((result) => {
          return suite.suite + " / " + result.name + ": "
            + result.error.message;
        });
    });

    throw new TestFailure(
      "Fleet fixture suite failed: " + failures.join("; "),
      combined,
    );
  }

  return combined;
}

async function printDemoSummary() {
  const result = await runHealthyReleaseScenario();
  const summary = {
    releaseId: result.release.id,
    releaseStatus: result.release.status,
    artifactVersion: result.release.artifact.version,
    tenantCount: result.release.tenantIds.length,
    deploymentCount: result.snapshot.deployments.length,
    auditEventCount: result.snapshot.audits.length,
    traceCount: result.snapshot.traces.length,
    openAlerts: result.snapshot.alerts.filter((alert) => {
      return alert.status === "open";
    }).length,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

async function main() {
  const mode = process.env.KIRON_FLEET_DEMO;

  if (mode === "tests") {
    const result = await runFleetTests();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (mode === "scenario") {
    await printDemoSummary();
  }
}

if (
  typeof process !== "undefined"
  && process.env
  && process.env.KIRON_FLEET_DEMO
) {
  void main().catch((error) => {
    process.stderr.write(
      JSON.stringify(
        {
          name: error.name,
          code: error.code,
          message: error.message,
          details: error.details,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  });
}
