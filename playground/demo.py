"""Kiron Fleet Control Plane playground.

The module is intentionally broad enough to exercise a light color theme against
real application code. It models tenant-aware release orchestration, feature
flags, audit trails, SLO policy, alerts, progressive delivery, and rollback.
Everything remains in memory so the file can serve as both documentation and a
deterministic test fixture.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from io import StringIO
from typing import Callable, Iterable, Iterator, Mapping, Protocol, Sequence, TextIO
from uuid import UUID, uuid5


CONTROL_PLANE_NAMESPACE = UUID("ba5015f6-0c11-4d33-a2c2-00f4c5ed61b1")
DEFAULT_SLO_TARGET = 99.9
DEFAULT_CANARY_PERCENT = 5
MAX_AUDIT_PAGE_SIZE = 200


class Environment(StrEnum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class TenantTier(StrEnum):
    STARTER = "starter"
    GROWTH = "growth"
    ENTERPRISE = "enterprise"


class ReleaseState(StrEnum):
    DRAFT = "draft"
    READY = "ready"
    RUNNING = "running"
    PAUSED = "paused"
    SUCCEEDED = "succeeded"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"
    FAILED = "failed"


class StageKind(StrEnum):
    CANARY = "canary"
    REGIONAL = "regional"
    GLOBAL = "global"


class FlagKind(StrEnum):
    BOOLEAN = "boolean"
    STRING = "string"
    NUMBER = "number"


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class AlertState(StrEnum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class AuditAction(StrEnum):
    RELEASE_CREATED = "release.created"
    RELEASE_STARTED = "release.started"
    STAGE_PROMOTED = "release.stage_promoted"
    RELEASE_PAUSED = "release.paused"
    RELEASE_ROLLED_BACK = "release.rolled_back"
    FLAG_CHANGED = "flag.changed"
    ALERT_OPENED = "alert.opened"
    ALERT_ACKNOWLEDGED = "alert.acknowledged"
    ALERT_RESOLVED = "alert.resolved"


class FleetError(Exception):
    """Base error carrying a stable control-plane error code."""

    code = "fleet_error"

    def __init__(self, message: str, *, details: Mapping[str, object] | None = None):
        super().__init__(message)
        self.details = dict(details or {})


class ValidationError(FleetError):
    code = "validation_error"


class NotFoundError(FleetError):
    code = "not_found"


class ConflictError(FleetError):
    code = "conflict"


class PolicyViolationError(FleetError):
    code = "policy_violation"


class AdapterError(FleetError):
    code = "adapter_error"


def stable_id(kind: str, *parts: str) -> str:
    """Return deterministic fixture identifiers without global mutable counters."""

    payload = ":".join((kind, *parts))
    return f"{kind}_{uuid5(CONTROL_PLANE_NAMESPACE, payload).hex[:16]}"


def require_slug(value: str, field_name: str) -> str:
    normalized = value.strip().lower()
    if not normalized:
        raise ValidationError(f"{field_name} cannot be empty")
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789-_")
    if normalized[0] not in set("abcdefghijklmnopqrstuvwxyz"):
        raise ValidationError(f"{field_name} must begin with a letter")
    if any(character not in allowed for character in normalized):
        raise ValidationError(
            f"{field_name} contains unsupported characters",
            details={"value": value},
        )
    return normalized


def require_percentage(value: int, field_name: str) -> int:
    if not 0 <= value <= 100:
        raise ValidationError(
            f"{field_name} must be between 0 and 100",
            details={"value": value},
        )
    return value


def require_positive(value: float, field_name: str) -> float:
    if value <= 0:
        raise ValidationError(
            f"{field_name} must be positive",
            details={"value": value},
        )
    return value


def parse_semver(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValidationError(
            "artifact version must use major.minor.patch",
            details={"version": value},
        )
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class TenantPolicy:
    tenant_id: str
    display_name: str
    tier: TenantTier
    allowed_regions: tuple[str, ...]
    production_approvers: int
    max_canary_percent: int
    minimum_slo_target: float
    freeze_windows_utc: tuple[tuple[int, int], ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", require_slug(self.tenant_id, "tenant_id"))
        if not self.display_name.strip():
            raise ValidationError("display_name cannot be empty")
        if not self.allowed_regions:
            raise ValidationError("at least one region is required")
        if len(set(self.allowed_regions)) != len(self.allowed_regions):
            raise ValidationError("allowed regions must be unique")
        if self.production_approvers < 1:
            raise ValidationError("production_approvers must be at least one")
        require_percentage(self.max_canary_percent, "max_canary_percent")
        if not 90 <= self.minimum_slo_target <= 100:
            raise ValidationError("minimum_slo_target must be between 90 and 100")
        for start_hour, end_hour in self.freeze_windows_utc:
            if not (0 <= start_hour <= 23 and 0 <= end_hour <= 23):
                raise ValidationError("freeze window hours must be valid")

    def allows_region(self, region: str) -> bool:
        return region in self.allowed_regions

    def is_frozen(self, moment: datetime) -> bool:
        hour = moment.astimezone(UTC).hour
        return any(
            start <= hour < end if start < end else hour >= start or hour < end
            for start, end in self.freeze_windows_utc
        )


@dataclass(frozen=True, slots=True)
class ServiceTarget:
    service: str
    environment: Environment
    regions: tuple[str, ...]
    desired_replicas: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "service", require_slug(self.service, "service"))
        if not self.regions:
            raise ValidationError("release target requires at least one region")
        if self.desired_replicas < 1:
            raise ValidationError("desired_replicas must be positive")


@dataclass(frozen=True, slots=True)
class Artifact:
    digest: str
    version: str
    source_revision: str
    created_at: datetime
    sbom_reference: str

    def __post_init__(self) -> None:
        if not self.digest.startswith("sha256:") or len(self.digest) < 24:
            raise ValidationError("artifact digest must be a sha256 reference")
        parse_semver(self.version)
        if len(self.source_revision) < 7:
            raise ValidationError("source_revision is too short")
        if not self.sbom_reference.startswith("sbom://"):
            raise ValidationError("sbom_reference must use sbom://")


@dataclass(frozen=True, slots=True)
class RolloutStage:
    name: str
    kind: StageKind
    traffic_percent: int
    regions: tuple[str, ...]
    minimum_observation: timedelta
    required_healthy_checks: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_slug(self.name, "stage.name"))
        require_percentage(self.traffic_percent, "traffic_percent")
        if not self.regions:
            raise ValidationError("stage requires at least one region")
        if self.minimum_observation < timedelta(minutes=1):
            raise ValidationError("minimum observation must be at least one minute")
        if self.required_healthy_checks < 1:
            raise ValidationError("required_healthy_checks must be positive")


@dataclass(frozen=True, slots=True)
class ReleasePlan:
    id: str
    tenant_id: str
    target: ServiceTarget
    artifact: Artifact
    stages: tuple[RolloutStage, ...]
    created_by: str
    created_at: datetime
    approvals: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.stages:
            raise ValidationError("release plan requires at least one stage")
        percentages = [stage.traffic_percent for stage in self.stages]
        if percentages != sorted(percentages):
            raise ValidationError("stage traffic must increase monotonically")
        if percentages[-1] != 100:
            raise ValidationError("final rollout stage must carry 100 percent traffic")
        names = [stage.name for stage in self.stages]
        if len(names) != len(set(names)):
            raise ValidationError("stage names must be unique")

    @property
    def production(self) -> bool:
        return self.target.environment is Environment.PRODUCTION


@dataclass(frozen=True, slots=True)
class Deployment:
    id: str
    plan: ReleasePlan
    state: ReleaseState
    current_stage_index: int
    started_at: datetime | None = None
    finished_at: datetime | None = None
    rollback_reason: str | None = None
    baseline_version: str | None = None
    revision: int = 0

    @property
    def current_stage(self) -> RolloutStage:
        return self.plan.stages[self.current_stage_index]

    @property
    def terminal(self) -> bool:
        return self.state in {
            ReleaseState.SUCCEEDED,
            ReleaseState.ROLLED_BACK,
            ReleaseState.FAILED,
        }


@dataclass(frozen=True, slots=True)
class FlagRule:
    id: str
    description: str
    percentage: int
    regions: tuple[str, ...] = ()
    tenant_tiers: tuple[TenantTier, ...] = ()
    attributes: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        require_percentage(self.percentage, "flag percentage")


@dataclass(frozen=True, slots=True)
class FeatureFlag:
    key: str
    tenant_id: str
    kind: FlagKind
    enabled: bool
    default_value: bool | str | float
    rules: tuple[FlagRule, ...]
    version: int
    updated_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "key", require_slug(self.key, "flag.key"))
        if self.version < 1:
            raise ValidationError("flag version must be positive")


@dataclass(frozen=True, slots=True)
class FlagContext:
    subject_id: str
    region: str
    tenant_tier: TenantTier
    attributes: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class FlagDecision:
    key: str
    value: bool | str | float
    matched_rule: str | None
    reason: str


@dataclass(frozen=True, slots=True)
class SLODefinition:
    service: str
    environment: Environment
    availability_target: float
    latency_p95_ms: float
    window: timedelta

    def __post_init__(self) -> None:
        if not 90 <= self.availability_target <= 100:
            raise ValidationError("availability target must be between 90 and 100")
        require_positive(self.latency_p95_ms, "latency_p95_ms")
        if self.window < timedelta(hours=1):
            raise ValidationError("SLO window must be at least one hour")


@dataclass(frozen=True, slots=True)
class MetricSnapshot:
    service: str
    environment: Environment
    region: str
    sampled_at: datetime
    request_count: int
    error_count: int
    latency_p95_ms: float

    @property
    def availability(self) -> float:
        if self.request_count == 0:
            return 100.0
        return 100.0 * (self.request_count - self.error_count) / self.request_count


@dataclass(frozen=True, slots=True)
class SLOAssessment:
    definition: SLODefinition
    snapshots: tuple[MetricSnapshot, ...]
    availability: float
    worst_latency_p95_ms: float
    error_budget_remaining: float
    healthy: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Alert:
    id: str
    tenant_id: str
    service: str
    severity: AlertSeverity
    state: AlertState
    summary: str
    deduplication_key: str
    opened_at: datetime
    acknowledged_by: str | None = None
    resolved_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class AuditEvent:
    id: str
    tenant_id: str
    actor: str
    action: AuditAction
    target_type: str
    target_id: str
    occurred_at: datetime
    metadata: tuple[tuple[str, str], ...]
    correlation_id: str


@dataclass(frozen=True, slots=True)
class TraceRecord:
    trace_id: str
    operation: str
    started_at: datetime
    finished_at: datetime
    attributes: tuple[tuple[str, str], ...]
    error_code: str | None = None

    @property
    def duration_ms(self) -> float:
        return (self.finished_at - self.started_at).total_seconds() * 1000


@dataclass(frozen=True, slots=True)
class ReleaseRequest:
    tenant_id: str
    service: str
    environment: Environment
    regions: tuple[str, ...]
    artifact: Artifact
    requested_by: str
    approvers: tuple[str, ...]
    desired_replicas: int = 3
    canary_percent: int = DEFAULT_CANARY_PERCENT


@dataclass(frozen=True, slots=True)
class PromotionDecision:
    allowed: bool
    reason: str
    assessment: SLOAssessment | None


class Clock(Protocol):
    def now(self) -> datetime:
        ...


class RuntimeAdapter(Protocol):
    def deploy(
        self,
        deployment: Deployment,
        stage: RolloutStage,
    ) -> None:
        ...

    def rollback(
        self,
        deployment: Deployment,
        baseline_version: str,
    ) -> None:
        ...


class NotificationAdapter(Protocol):
    def send(self, channel: str, subject: str, body: str) -> None:
        ...


class MetricsAdapter(Protocol):
    def snapshots(
        self,
        service: str,
        environment: Environment,
        regions: Sequence[str],
        since: datetime,
    ) -> Sequence[MetricSnapshot]:
        ...


class FrozenClock:
    def __init__(self, moment: datetime):
        self._moment = moment.astimezone(UTC)

    def now(self) -> datetime:
        return self._moment

    def advance(self, delta: timedelta) -> None:
        self._moment += delta


class InMemoryTenantRepository:
    def __init__(self, policies: Iterable[TenantPolicy] = ()):
        self._policies = {policy.tenant_id: policy for policy in policies}

    def get(self, tenant_id: str) -> TenantPolicy:
        try:
            return self._policies[tenant_id]
        except KeyError as error:
            raise NotFoundError(
                "tenant policy not found",
                details={"tenant_id": tenant_id},
            ) from error

    def save(self, policy: TenantPolicy) -> None:
        self._policies[policy.tenant_id] = policy

    def list_all(self) -> tuple[TenantPolicy, ...]:
        return tuple(sorted(self._policies.values(), key=lambda item: item.tenant_id))


class InMemoryDeploymentRepository:
    def __init__(self) -> None:
        self._deployments: dict[str, Deployment] = {}

    def get(self, deployment_id: str) -> Deployment:
        try:
            return self._deployments[deployment_id]
        except KeyError as error:
            raise NotFoundError(
                "deployment not found",
                details={"deployment_id": deployment_id},
            ) from error

    def save(self, deployment: Deployment, expected_revision: int | None = None) -> Deployment:
        current = self._deployments.get(deployment.id)
        if expected_revision is not None:
            actual = current.revision if current else 0
            if actual != expected_revision:
                raise ConflictError(
                    "deployment revision changed",
                    details={
                        "deployment_id": deployment.id,
                        "expected": expected_revision,
                        "actual": actual,
                    },
                )
        next_revision = (current.revision if current else 0) + 1
        stored = replace(deployment, revision=next_revision)
        self._deployments[stored.id] = stored
        return stored

    def list_for_tenant(self, tenant_id: str) -> tuple[Deployment, ...]:
        return tuple(
            item
            for item in self._deployments.values()
            if item.plan.tenant_id == tenant_id
        )


class InMemoryFlagRepository:
    def __init__(self, flags: Iterable[FeatureFlag] = ()):
        self._flags = {(flag.tenant_id, flag.key): flag for flag in flags}

    def get(self, tenant_id: str, key: str) -> FeatureFlag:
        try:
            return self._flags[(tenant_id, key)]
        except KeyError as error:
            raise NotFoundError(
                "feature flag not found",
                details={"tenant_id": tenant_id, "key": key},
            ) from error

    def save(self, flag: FeatureFlag, expected_version: int | None = None) -> FeatureFlag:
        current = self._flags.get((flag.tenant_id, flag.key))
        if expected_version is not None:
            actual = current.version if current else 0
            if actual != expected_version:
                raise ConflictError(
                    "feature flag version changed",
                    details={"expected": expected_version, "actual": actual},
                )
        self._flags[(flag.tenant_id, flag.key)] = flag
        return flag


class InMemoryAlertRepository:
    def __init__(self) -> None:
        self._alerts: dict[str, Alert] = {}
        self._open_by_deduplication_key: dict[str, str] = {}

    def save(self, alert: Alert) -> Alert:
        self._alerts[alert.id] = alert
        if alert.state is AlertState.RESOLVED:
            self._open_by_deduplication_key.pop(alert.deduplication_key, None)
        else:
            self._open_by_deduplication_key[alert.deduplication_key] = alert.id
        return alert

    def find_open(self, deduplication_key: str) -> Alert | None:
        alert_id = self._open_by_deduplication_key.get(deduplication_key)
        return self._alerts.get(alert_id) if alert_id else None

    def get(self, alert_id: str) -> Alert:
        try:
            return self._alerts[alert_id]
        except KeyError as error:
            raise NotFoundError("alert not found") from error


class InMemoryAuditRepository:
    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def append(self, event: AuditEvent) -> None:
        self._events.append(event)

    def query(
        self,
        tenant_id: str,
        *,
        action: AuditAction | None = None,
        limit: int = 50,
    ) -> tuple[AuditEvent, ...]:
        safe_limit = min(max(limit, 1), MAX_AUDIT_PAGE_SIZE)
        matches = (
            event
            for event in reversed(self._events)
            if event.tenant_id == tenant_id and (action is None or event.action is action)
        )
        return tuple(event for _, event in zip(range(safe_limit), matches))


class RecordingRuntimeAdapter:
    def __init__(self) -> None:
        self.deployments: list[tuple[str, str, int]] = []
        self.rollbacks: list[tuple[str, str]] = []
        self.fail_next_operation = False

    def deploy(self, deployment: Deployment, stage: RolloutStage) -> None:
        if self.fail_next_operation:
            self.fail_next_operation = False
            raise AdapterError("runtime rejected deployment")
        self.deployments.append(
            (deployment.id, stage.name, stage.traffic_percent)
        )

    def rollback(self, deployment: Deployment, baseline_version: str) -> None:
        if self.fail_next_operation:
            self.fail_next_operation = False
            raise AdapterError("runtime rejected rollback")
        self.rollbacks.append((deployment.id, baseline_version))


class RecordingNotificationAdapter:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str, str]] = []

    def send(self, channel: str, subject: str, body: str) -> None:
        self.messages.append((channel, subject, body))


class FixtureMetricsAdapter:
    def __init__(self, snapshots: Iterable[MetricSnapshot] = ()):
        self._snapshots = list(snapshots)

    def replace(self, snapshots: Iterable[MetricSnapshot]) -> None:
        self._snapshots = list(snapshots)

    def snapshots(
        self,
        service: str,
        environment: Environment,
        regions: Sequence[str],
        since: datetime,
    ) -> Sequence[MetricSnapshot]:
        region_set = set(regions)
        return tuple(
            item
            for item in self._snapshots
            if item.service == service
            and item.environment is environment
            and item.region in region_set
            and item.sampled_at >= since
        )


class TraceCollector:
    def __init__(self, clock: Clock):
        self._clock = clock
        self.records: list[TraceRecord] = []

    def traced(
        self,
        operation: str,
        attributes: Mapping[str, str],
        callback: Callable[[], object],
    ) -> object:
        started_at = self._clock.now()
        trace_id = stable_id("trace", operation, str(len(self.records)))
        try:
            result = callback()
        except FleetError as error:
            self.records.append(
                TraceRecord(
                    trace_id=trace_id,
                    operation=operation,
                    started_at=started_at,
                    finished_at=self._clock.now(),
                    attributes=tuple(sorted(attributes.items())),
                    error_code=error.code,
                )
            )
            raise
        self.records.append(
            TraceRecord(
                trace_id=trace_id,
                operation=operation,
                started_at=started_at,
                finished_at=self._clock.now(),
                attributes=tuple(sorted(attributes.items())),
            )
        )
        return result


class CounterRegistry:
    def __init__(self) -> None:
        self._values: defaultdict[tuple[str, tuple[tuple[str, str], ...]], int]
        self._values = defaultdict(int)

    def increment(self, name: str, **labels: str) -> None:
        self._values[(name, tuple(sorted(labels.items())))] += 1

    def value(self, name: str, **labels: str) -> int:
        return self._values[(name, tuple(sorted(labels.items())))]

    def export_lines(self) -> tuple[str, ...]:
        lines = []
        for (name, labels), value in sorted(self._values.items()):
            serialized = ",".join(f'{key}="{item}"' for key, item in labels)
            suffix = f"{{{serialized}}}" if serialized else ""
            lines.append(f"{name}{suffix} {value}")
        return tuple(lines)


class AuditService:
    def __init__(
        self,
        repository: InMemoryAuditRepository,
        clock: Clock,
    ):
        self._repository = repository
        self._clock = clock

    def record(
        self,
        tenant_id: str,
        actor: str,
        action: AuditAction,
        target_type: str,
        target_id: str,
        metadata: Mapping[str, str],
        correlation_id: str,
    ) -> AuditEvent:
        event = AuditEvent(
            id=stable_id(
                "audit",
                tenant_id,
                action.value,
                target_id,
                str(self._clock.now().timestamp()),
            ),
            tenant_id=tenant_id,
            actor=actor,
            action=action,
            target_type=target_type,
            target_id=target_id,
            occurred_at=self._clock.now(),
            metadata=tuple(sorted(metadata.items())),
            correlation_id=correlation_id,
        )
        self._repository.append(event)
        return event


class FeatureFlagService:
    def __init__(
        self,
        repository: InMemoryFlagRepository,
        audit: AuditService,
        clock: Clock,
    ):
        self._repository = repository
        self._audit = audit
        self._clock = clock

    def evaluate(
        self,
        tenant_id: str,
        key: str,
        context: FlagContext,
    ) -> FlagDecision:
        flag = self._repository.get(tenant_id, key)
        if not flag.enabled:
            return FlagDecision(key, flag.default_value, None, "flag_disabled")
        bucket = int(
            uuid5(
                CONTROL_PLANE_NAMESPACE,
                f"{tenant_id}:{key}:{context.subject_id}",
            ).hex[:8],
            16,
        ) % 100
        for rule in flag.rules:
            if rule.regions and context.region not in rule.regions:
                continue
            if rule.tenant_tiers and context.tenant_tier not in rule.tenant_tiers:
                continue
            if any(context.attributes.get(name) != value for name, value in rule.attributes):
                continue
            if bucket < rule.percentage:
                return FlagDecision(key, True, rule.id, "rule_match")
        return FlagDecision(key, flag.default_value, None, "default")

    def update(
        self,
        tenant_id: str,
        key: str,
        actor: str,
        *,
        enabled: bool,
        rules: Sequence[FlagRule],
        expected_version: int,
        correlation_id: str,
    ) -> FeatureFlag:
        current = self._repository.get(tenant_id, key)
        updated = replace(
            current,
            enabled=enabled,
            rules=tuple(rules),
            version=current.version + 1,
            updated_at=self._clock.now(),
        )
        saved = self._repository.save(updated, expected_version)
        self._audit.record(
            tenant_id,
            actor,
            AuditAction.FLAG_CHANGED,
            "feature_flag",
            key,
            {
                "enabled": str(enabled).lower(),
                "version": str(saved.version),
            },
            correlation_id,
        )
        return saved


class SLOService:
    def __init__(self, metrics: MetricsAdapter, clock: Clock):
        self._metrics = metrics
        self._clock = clock

    def assess(
        self,
        definition: SLODefinition,
        regions: Sequence[str],
    ) -> SLOAssessment:
        snapshots = tuple(
            self._metrics.snapshots(
                definition.service,
                definition.environment,
                regions,
                self._clock.now() - definition.window,
            )
        )
        if not snapshots:
            return SLOAssessment(
                definition=definition,
                snapshots=(),
                availability=0.0,
                worst_latency_p95_ms=float("inf"),
                error_budget_remaining=0.0,
                healthy=False,
                reasons=("missing_metrics",),
            )
        total_requests = sum(item.request_count for item in snapshots)
        total_errors = sum(item.error_count for item in snapshots)
        availability = (
            100.0 if total_requests == 0
            else 100.0 * (total_requests - total_errors) / total_requests
        )
        worst_latency = max(item.latency_p95_ms for item in snapshots)
        permitted_failure = max(100.0 - definition.availability_target, 0.0001)
        actual_failure = 100.0 - availability
        budget_remaining = max(0.0, 100.0 * (1.0 - actual_failure / permitted_failure))
        reasons: list[str] = []
        if availability < definition.availability_target:
            reasons.append("availability_below_target")
        if worst_latency > definition.latency_p95_ms:
            reasons.append("latency_above_target")
        return SLOAssessment(
            definition=definition,
            snapshots=snapshots,
            availability=availability,
            worst_latency_p95_ms=worst_latency,
            error_budget_remaining=budget_remaining,
            healthy=not reasons,
            reasons=tuple(reasons),
        )


class AlertService:
    def __init__(
        self,
        repository: InMemoryAlertRepository,
        notifications: NotificationAdapter,
        audit: AuditService,
        clock: Clock,
    ):
        self._repository = repository
        self._notifications = notifications
        self._audit = audit
        self._clock = clock

    def open_for_assessment(
        self,
        tenant_id: str,
        assessment: SLOAssessment,
        correlation_id: str,
    ) -> Alert | None:
        if assessment.healthy:
            return None
        severity = (
            AlertSeverity.CRITICAL
            if assessment.error_budget_remaining <= 10
            else AlertSeverity.WARNING
        )
        service = assessment.definition.service
        deduplication_key = (
            f"{tenant_id}:{service}:{assessment.definition.environment.value}:slo"
        )
        existing = self._repository.find_open(deduplication_key)
        if existing:
            return existing
        summary = (
            f"{service} violates SLO: {', '.join(assessment.reasons)}"
        )
        alert = Alert(
            id=stable_id("alert", deduplication_key, str(self._clock.now().timestamp())),
            tenant_id=tenant_id,
            service=service,
            severity=severity,
            state=AlertState.OPEN,
            summary=summary,
            deduplication_key=deduplication_key,
            opened_at=self._clock.now(),
        )
        self._repository.save(alert)
        self._notifications.send(
            "fleet-oncall",
            f"[{severity.value}] {service}",
            summary,
        )
        self._audit.record(
            tenant_id,
            "system:slo-evaluator",
            AuditAction.ALERT_OPENED,
            "alert",
            alert.id,
            {"severity": severity.value},
            correlation_id,
        )
        return alert

    def acknowledge(
        self,
        alert_id: str,
        actor: str,
        correlation_id: str,
    ) -> Alert:
        current = self._repository.get(alert_id)
        if current.state is AlertState.RESOLVED:
            raise ConflictError("resolved alert cannot be acknowledged")
        updated = replace(
            current,
            state=AlertState.ACKNOWLEDGED,
            acknowledged_by=actor,
        )
        self._repository.save(updated)
        self._audit.record(
            updated.tenant_id,
            actor,
            AuditAction.ALERT_ACKNOWLEDGED,
            "alert",
            updated.id,
            {},
            correlation_id,
        )
        return updated

    def resolve(
        self,
        alert_id: str,
        actor: str,
        correlation_id: str,
    ) -> Alert:
        current = self._repository.get(alert_id)
        updated = replace(
            current,
            state=AlertState.RESOLVED,
            resolved_at=self._clock.now(),
        )
        self._repository.save(updated)
        self._audit.record(
            updated.tenant_id,
            actor,
            AuditAction.ALERT_RESOLVED,
            "alert",
            updated.id,
            {},
            correlation_id,
        )
        return updated


class ReleasePlanner:
    def __init__(
        self,
        tenants: InMemoryTenantRepository,
        clock: Clock,
    ):
        self._tenants = tenants
        self._clock = clock

    def create(self, request: ReleaseRequest) -> ReleasePlan:
        policy = self._tenants.get(request.tenant_id)
        invalid_regions = [
            region for region in request.regions if not policy.allows_region(region)
        ]
        if invalid_regions:
            raise PolicyViolationError(
                "tenant policy denies requested regions",
                details={"regions": invalid_regions},
            )
        if request.environment is Environment.PRODUCTION:
            if len(set(request.approvers)) < policy.production_approvers:
                raise PolicyViolationError(
                    "not enough independent production approvals",
                    details={
                        "required": policy.production_approvers,
                        "actual": len(set(request.approvers)),
                    },
                )
            if policy.is_frozen(self._clock.now()):
                raise PolicyViolationError("production release freeze is active")
        canary_percent = require_percentage(
            request.canary_percent,
            "canary_percent",
        )
        if canary_percent > policy.max_canary_percent:
            raise PolicyViolationError(
                "requested canary exceeds tenant policy",
                details={
                    "requested": canary_percent,
                    "maximum": policy.max_canary_percent,
                },
            )
        stages = self._build_stages(request.regions, canary_percent)
        plan_id = stable_id(
            "plan",
            request.tenant_id,
            request.service,
            request.artifact.digest,
            request.environment.value,
        )
        return ReleasePlan(
            id=plan_id,
            tenant_id=request.tenant_id,
            target=ServiceTarget(
                service=request.service,
                environment=request.environment,
                regions=request.regions,
                desired_replicas=request.desired_replicas,
            ),
            artifact=request.artifact,
            stages=stages,
            created_by=request.requested_by,
            created_at=self._clock.now(),
            approvals=tuple(dict.fromkeys(request.approvers)),
        )

    @staticmethod
    def _build_stages(
        regions: tuple[str, ...],
        canary_percent: int,
    ) -> tuple[RolloutStage, ...]:
        first_region = (regions[0],)
        return (
            RolloutStage(
                name="canary",
                kind=StageKind.CANARY,
                traffic_percent=canary_percent,
                regions=first_region,
                minimum_observation=timedelta(minutes=10),
                required_healthy_checks=3,
            ),
            RolloutStage(
                name="regional",
                kind=StageKind.REGIONAL,
                traffic_percent=35,
                regions=regions,
                minimum_observation=timedelta(minutes=20),
                required_healthy_checks=4,
            ),
            RolloutStage(
                name="global",
                kind=StageKind.GLOBAL,
                traffic_percent=100,
                regions=regions,
                minimum_observation=timedelta(minutes=30),
                required_healthy_checks=6,
            ),
        )


class RolloutOrchestrator:
    def __init__(
        self,
        deployments: InMemoryDeploymentRepository,
        runtime: RuntimeAdapter,
        slo_service: SLOService,
        alert_service: AlertService,
        audit: AuditService,
        traces: TraceCollector,
        counters: CounterRegistry,
        clock: Clock,
    ):
        self._deployments = deployments
        self._runtime = runtime
        self._slo_service = slo_service
        self._alert_service = alert_service
        self._audit = audit
        self._traces = traces
        self._counters = counters
        self._clock = clock

    def start(
        self,
        plan: ReleasePlan,
        baseline_version: str,
        correlation_id: str,
    ) -> Deployment:
        deployment = Deployment(
            id=stable_id("deployment", plan.id),
            plan=plan,
            state=ReleaseState.READY,
            current_stage_index=0,
            baseline_version=baseline_version,
        )

        def operation() -> Deployment:
            running = replace(
                deployment,
                state=ReleaseState.RUNNING,
                started_at=self._clock.now(),
            )
            stored = self._deployments.save(running, expected_revision=0)
            try:
                self._runtime.deploy(stored, stored.current_stage)
            except AdapterError:
                failed = replace(
                    stored,
                    state=ReleaseState.FAILED,
                    finished_at=self._clock.now(),
                )
                self._deployments.save(failed, expected_revision=stored.revision)
                self._counters.increment(
                    "fleet_release_total",
                    outcome="failed",
                    environment=plan.target.environment.value,
                )
                raise
            self._audit.record(
                plan.tenant_id,
                plan.created_by,
                AuditAction.RELEASE_STARTED,
                "deployment",
                stored.id,
                {"stage": stored.current_stage.name},
                correlation_id,
            )
            self._counters.increment(
                "fleet_release_total",
                outcome="started",
                environment=plan.target.environment.value,
            )
            return stored

        result = self._traces.traced(
            "rollout.start",
            {
                "tenant_id": plan.tenant_id,
                "service": plan.target.service,
            },
            operation,
        )
        assert isinstance(result, Deployment)
        return result

    def promotion_decision(
        self,
        deployment_id: str,
        definition: SLODefinition,
    ) -> PromotionDecision:
        deployment = self._deployments.get(deployment_id)
        if deployment.state is not ReleaseState.RUNNING:
            return PromotionDecision(False, "deployment_not_running", None)
        assessment = self._slo_service.assess(
            definition,
            deployment.current_stage.regions,
        )
        if not assessment.healthy:
            return PromotionDecision(False, "slo_gate_failed", assessment)
        return PromotionDecision(True, "slo_gate_passed", assessment)

    def promote(
        self,
        deployment_id: str,
        actor: str,
        definition: SLODefinition,
        correlation_id: str,
    ) -> Deployment:
        current = self._deployments.get(deployment_id)
        decision = self.promotion_decision(deployment_id, definition)
        if not decision.allowed:
            if decision.assessment:
                self._alert_service.open_for_assessment(
                    current.plan.tenant_id,
                    decision.assessment,
                    correlation_id,
                )
            raise PolicyViolationError(
                "rollout promotion denied",
                details={"reason": decision.reason},
            )
        next_index = current.current_stage_index + 1
        if next_index >= len(current.plan.stages):
            succeeded = replace(
                current,
                state=ReleaseState.SUCCEEDED,
                finished_at=self._clock.now(),
            )
            stored = self._deployments.save(
                succeeded,
                expected_revision=current.revision,
            )
            self._counters.increment(
                "fleet_release_total",
                outcome="succeeded",
                environment=current.plan.target.environment.value,
            )
            return stored
        promoted = replace(current, current_stage_index=next_index)
        stored = self._deployments.save(
            promoted,
            expected_revision=current.revision,
        )
        try:
            self._runtime.deploy(stored, stored.current_stage)
        except AdapterError:
            paused = replace(stored, state=ReleaseState.PAUSED)
            self._deployments.save(paused, expected_revision=stored.revision)
            raise
        self._audit.record(
            current.plan.tenant_id,
            actor,
            AuditAction.STAGE_PROMOTED,
            "deployment",
            current.id,
            {"stage": stored.current_stage.name},
            correlation_id,
        )
        self._counters.increment(
            "fleet_promotion_total",
            stage=stored.current_stage.name,
        )
        return stored

    def rollback(
        self,
        deployment_id: str,
        actor: str,
        reason: str,
        correlation_id: str,
    ) -> Deployment:
        current = self._deployments.get(deployment_id)
        if current.terminal:
            raise ConflictError("terminal deployment cannot be rolled back")
        if not current.baseline_version:
            raise PolicyViolationError("rollback baseline is unavailable")
        rolling_back = replace(
            current,
            state=ReleaseState.ROLLING_BACK,
            rollback_reason=reason,
        )
        stored = self._deployments.save(
            rolling_back,
            expected_revision=current.revision,
        )
        try:
            self._runtime.rollback(stored, current.baseline_version)
        except AdapterError:
            failed = replace(
                stored,
                state=ReleaseState.FAILED,
                finished_at=self._clock.now(),
            )
            self._deployments.save(failed, expected_revision=stored.revision)
            raise
        completed = replace(
            stored,
            state=ReleaseState.ROLLED_BACK,
            finished_at=self._clock.now(),
        )
        completed = self._deployments.save(
            completed,
            expected_revision=stored.revision,
        )
        self._audit.record(
            current.plan.tenant_id,
            actor,
            AuditAction.RELEASE_ROLLED_BACK,
            "deployment",
            current.id,
            {"reason": reason},
            correlation_id,
        )
        self._counters.increment(
            "fleet_release_total",
            outcome="rolled_back",
            environment=current.plan.target.environment.value,
        )
        return completed


def read_case(stream):
    """Untyped calls verify the Python TextMate fallback for dot functions."""

    return stream.readline().split()


def read_typed_case(stream: TextIO) -> list[str]:
    """Typed calls verify Pylance semantics alongside the TextMate fallback."""

    return stream.readline().split()


@dataclass(frozen=True, slots=True)
class TenantFixture:
    policy: TenantPolicy
    owner: str
    primary_service: str
    alert_channel: str
    expected_monthly_releases: int


@dataclass(frozen=True, slots=True)
class RolloutFixture:
    name: str
    tenant_id: str
    service: str
    environment: Environment
    regions: tuple[str, ...]
    canary_percent: int
    availability: float
    latency_p95_ms: float
    expected_action: str


FIXTURE_BASE_TIME = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)

TENANT_FIXTURES: tuple[TenantFixture, ...] = (
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="atlas-retail",
            display_name="Atlas Retail",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("us-east-1", "eu-west-1", "ap-southeast-1"),
            production_approvers=2,
            max_canary_percent=5,
            minimum_slo_target=99.95,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-blue-01",
        primary_service="checkout-api",
        alert_channel="#fleet-atlas-retail",
        expected_monthly_releases=8,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="boreal-bank",
            display_name="Boreal Bank",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-02",
        primary_service="identity-gateway",
        alert_channel="#fleet-boreal-bank",
        expected_monthly_releases=11,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="cinder-media",
            display_name="Cinder Media",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "eu-central-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-03",
        primary_service="event-router",
        alert_channel="#fleet-cinder-media",
        expected_monthly_releases=14,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="delta-health",
            display_name="Delta Health",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-violet-04",
        primary_service="policy-engine",
        alert_channel="#fleet-delta-health",
        expected_monthly_releases=17,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="ember-logistics",
            display_name="Ember Logistics",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "us-east-1", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-05",
        primary_service="catalog-read",
        alert_channel="#fleet-ember-logistics",
        expected_monthly_releases=20,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="fjord-energy",
            display_name="Fjord Energy",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=2,
            max_canary_percent=10,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-06",
        primary_service="media-transcoder",
        alert_channel="#fleet-fjord-energy",
        expected_monthly_releases=23,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="grove-learning",
            display_name="Grove Learning",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "us-west-2"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-green-07",
        primary_service="billing-worker",
        alert_channel="#fleet-grove-learning",
        expected_monthly_releases=26,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="harbor-travel",
            display_name="Harbor Travel",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-orange-08",
        primary_service="search-indexer",
        alert_channel="#fleet-harbor-travel",
        expected_monthly_releases=29,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="indigo-labs",
            display_name="Indigo Labs",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "ap-southeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-09",
        primary_service="notification-hub",
        alert_channel="#fleet-indigo-labs",
        expected_monthly_releases=32,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="juniper-pay",
            display_name="Juniper Pay",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-teal-10",
        primary_service="edge-config",
        alert_channel="#fleet-juniper-pay",
        expected_monthly_releases=35,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="keystone-cloud",
            display_name="Keystone Cloud",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("ap-southeast-1", "ap-northeast-1"),
            production_approvers=2,
            max_canary_percent=15,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-11",
        primary_service="checkout-api",
        alert_channel="#fleet-keystone-cloud",
        expected_monthly_releases=38,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="lattice-games",
            display_name="Lattice Games",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-12",
        primary_service="identity-gateway",
        alert_channel="#fleet-lattice-games",
        expected_monthly_releases=41,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="meridian-food",
            display_name="Meridian Food",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "eu-west-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-orange-13",
        primary_service="event-router",
        alert_channel="#fleet-meridian-food",
        expected_monthly_releases=8,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="northstar-auto",
            display_name="Northstar Auto",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-14",
        primary_service="policy-engine",
        alert_channel="#fleet-northstar-auto",
        expected_monthly_releases=11,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="opal-security",
            display_name="Opal Security",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "eu-central-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-teal-15",
        primary_service="catalog-read",
        alert_channel="#fleet-opal-security",
        expected_monthly_releases=14,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="prairie-ai",
            display_name="Prairie Ai",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=2,
            max_canary_percent=20,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-16",
        primary_service="media-transcoder",
        alert_channel="#fleet-prairie-ai",
        expected_monthly_releases=17,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="quartz-robotics",
            display_name="Quartz Robotics",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "us-east-1", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-17",
        primary_service="billing-worker",
        alert_channel="#fleet-quartz-robotics",
        expected_monthly_releases=20,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="rivet-commerce",
            display_name="Rivet Commerce",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-18",
        primary_service="search-indexer",
        alert_channel="#fleet-rivet-commerce",
        expected_monthly_releases=23,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="summit-insurance",
            display_name="Summit Insurance",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "us-west-2"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-violet-19",
        primary_service="notification-hub",
        alert_channel="#fleet-summit-insurance",
        expected_monthly_releases=26,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="tundra-mobile",
            display_name="Tundra Mobile",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-20",
        primary_service="edge-config",
        alert_channel="#fleet-tundra-mobile",
        expected_monthly_releases=29,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="uplink-data",
            display_name="Uplink Data",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("eu-west-1", "ap-southeast-1", "us-east-1"),
            production_approvers=2,
            max_canary_percent=5,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-21",
        primary_service="checkout-api",
        alert_channel="#fleet-uplink-data",
        expected_monthly_releases=32,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="valley-homes",
            display_name="Valley Homes",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.9,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-green-22",
        primary_service="identity-gateway",
        alert_channel="#fleet-valley-homes",
        expected_monthly_releases=35,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="willow-social",
            display_name="Willow Social",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "ap-northeast-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-23",
        primary_service="event-router",
        alert_channel="#fleet-willow-social",
        expected_monthly_releases=38,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="xenon-biotech",
            display_name="Xenon Biotech",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-24",
        primary_service="policy-engine",
        alert_channel="#fleet-xenon-biotech",
        expected_monthly_releases=41,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="yonder-maps",
            display_name="Yonder Maps",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "eu-west-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-teal-25",
        primary_service="catalog-read",
        alert_channel="#fleet-yonder-maps",
        expected_monthly_releases=8,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="zenith-stream",
            display_name="Zenith Stream",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=2,
            max_canary_percent=10,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-26",
        primary_service="media-transcoder",
        alert_channel="#fleet-zenith-stream",
        expected_monthly_releases=11,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="aurora-civic",
            display_name="Aurora Civic",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "eu-central-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-27",
        primary_service="billing-worker",
        alert_channel="#fleet-aurora-civic",
        expected_monthly_releases=14,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="bramble-books",
            display_name="Bramble Books",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-orange-28",
        primary_service="search-indexer",
        alert_channel="#fleet-bramble-books",
        expected_monthly_releases=17,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="coral-design",
            display_name="Coral Design",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "us-east-1", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-violet-29",
        primary_service="notification-hub",
        alert_channel="#fleet-coral-design",
        expected_monthly_releases=20,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="drift-finance",
            display_name="Drift Finance",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-30",
        primary_service="edge-config",
        alert_channel="#fleet-drift-finance",
        expected_monthly_releases=23,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="elm-mobility",
            display_name="Elm Mobility",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("us-east-1", "us-west-2"),
            production_approvers=2,
            max_canary_percent=15,
            minimum_slo_target=99.95,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-blue-31",
        primary_service="checkout-api",
        alert_channel="#fleet-elm-mobility",
        expected_monthly_releases=26,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="forge-analytics",
            display_name="Forge Analytics",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-32",
        primary_service="identity-gateway",
        alert_channel="#fleet-forge-analytics",
        expected_monthly_releases=29,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="glacier-storage",
            display_name="Glacier Storage",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "ap-southeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-33",
        primary_service="event-router",
        alert_channel="#fleet-glacier-storage",
        expected_monthly_releases=32,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="hearth-market",
            display_name="Hearth Market",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-violet-34",
        primary_service="policy-engine",
        alert_channel="#fleet-hearth-market",
        expected_monthly_releases=35,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="ion-weather",
            display_name="Ion Weather",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "ap-northeast-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-35",
        primary_service="catalog-read",
        alert_channel="#fleet-ion-weather",
        expected_monthly_releases=38,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="jade-identity",
            display_name="Jade Identity",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=2,
            max_canary_percent=20,
            minimum_slo_target=99.95,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-blue-36",
        primary_service="media-transcoder",
        alert_channel="#fleet-jade-identity",
        expected_monthly_releases=41,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="kestrel-devtools",
            display_name="Kestrel Devtools",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "eu-west-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-green-37",
        primary_service="billing-worker",
        alert_channel="#fleet-kestrel-devtools",
        expected_monthly_releases=8,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="lagoon-supply",
            display_name="Lagoon Supply",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-38",
        primary_service="search-indexer",
        alert_channel="#fleet-lagoon-supply",
        expected_monthly_releases=11,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="meadow-voice",
            display_name="Meadow Voice",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "eu-central-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-39",
        primary_service="notification-hub",
        alert_channel="#fleet-meadow-voice",
        expected_monthly_releases=14,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="nova-search",
            display_name="Nova Search",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-teal-40",
        primary_service="edge-config",
        alert_channel="#fleet-nova-search",
        expected_monthly_releases=17,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="orbit-photos",
            display_name="Orbit Photos",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("ap-southeast-1", "us-east-1", "eu-west-1"),
            production_approvers=2,
            max_canary_percent=5,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-41",
        primary_service="checkout-api",
        alert_channel="#fleet-orbit-photos",
        expected_monthly_releases=20,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="pine-observability",
            display_name="Pine Observability",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-42",
        primary_service="identity-gateway",
        alert_channel="#fleet-pine-observability",
        expected_monthly_releases=23,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="quiver-support",
            display_name="Quiver Support",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "us-west-2"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-orange-43",
        primary_service="event-router",
        alert_channel="#fleet-quiver-support",
        expected_monthly_releases=26,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="ridge-network",
            display_name="Ridge Network",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-44",
        primary_service="policy-engine",
        alert_channel="#fleet-ridge-network",
        expected_monthly_releases=29,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="spruce-workflows",
            display_name="Spruce Workflows",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "ap-southeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-45",
        primary_service="catalog-read",
        alert_channel="#fleet-spruce-workflows",
        expected_monthly_releases=32,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="terra-catalog",
            display_name="Terra Catalog",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=2,
            max_canary_percent=10,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-46",
        primary_service="media-transcoder",
        alert_channel="#fleet-terra-catalog",
        expected_monthly_releases=35,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="umber-compute",
            display_name="Umber Compute",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "ap-northeast-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-green-47",
        primary_service="billing-worker",
        alert_channel="#fleet-umber-compute",
        expected_monthly_releases=38,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="vista-collaboration",
            display_name="Vista Collaboration",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-48",
        primary_service="search-indexer",
        alert_channel="#fleet-vista-collaboration",
        expected_monthly_releases=41,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="wave-payments",
            display_name="Wave Payments",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "eu-west-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-violet-49",
        primary_service="notification-hub",
        alert_channel="#fleet-wave-payments",
        expected_monthly_releases=8,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="zephyr-edge",
            display_name="Zephyr Edge",
            tier=TenantTier.STARTER,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-teal-50",
        primary_service="edge-config",
        alert_channel="#fleet-zephyr-edge",
        expected_monthly_releases=11,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="acorn-legal",
            display_name="Acorn Legal",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("eu-west-1", "eu-central-1"),
            production_approvers=2,
            max_canary_percent=15,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-51",
        primary_service="checkout-api",
        alert_channel="#fleet-acorn-legal",
        expected_monthly_releases=14,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="beacon-news",
            display_name="Beacon News",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-green-52",
        primary_service="identity-gateway",
        alert_channel="#fleet-beacon-news",
        expected_monthly_releases=17,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="cascade-sports",
            display_name="Cascade Sports",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "us-east-1", "eu-west-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-orange-53",
        primary_service="event-router",
        alert_channel="#fleet-cascade-sports",
        expected_monthly_releases=20,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="dawn-agriculture",
            display_name="Dawn Agriculture",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-54",
        primary_service="policy-engine",
        alert_channel="#fleet-dawn-agriculture",
        expected_monthly_releases=23,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="echo-messaging",
            display_name="Echo Messaging",
            tier=TenantTier.GROWTH,
            allowed_regions=("us-east-1", "us-west-2"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.9,
            freeze_windows_utc=((22, 6),),
        ),
        owner="team-teal-55",
        primary_service="catalog-read",
        alert_channel="#fleet-echo-messaging",
        expected_monthly_releases=26,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="flint-construction",
            display_name="Flint Construction",
            tier=TenantTier.ENTERPRISE,
            allowed_regions=("us-west-2", "eu-west-1"),
            production_approvers=2,
            max_canary_percent=20,
            minimum_slo_target=99.95,
            freeze_windows_utc=(),
        ),
        owner="team-blue-56",
        primary_service="media-transcoder",
        alert_channel="#fleet-flint-construction",
        expected_monthly_releases=29,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="garden-productivity",
            display_name="Garden Productivity",
            tier=TenantTier.STARTER,
            allowed_regions=("eu-west-1", "ap-southeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=5,
            minimum_slo_target=99.5,
            freeze_windows_utc=((0, 4), (18, 20)),
        ),
        owner="team-green-57",
        primary_service="billing-worker",
        alert_channel="#fleet-garden-productivity",
        expected_monthly_releases=32,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="horizon-events",
            display_name="Horizon Events",
            tier=TenantTier.GROWTH,
            allowed_regions=("eu-central-1", "ap-southeast-1"),
            production_approvers=1,
            max_canary_percent=10,
            minimum_slo_target=99.9,
            freeze_windows_utc=(),
        ),
        owner="team-orange-58",
        primary_service="search-indexer",
        alert_channel="#fleet-horizon-events",
        expected_monthly_releases=35,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="island-delivery",
            display_name="Island Delivery",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-southeast-1", "ap-northeast-1"),
            production_approvers=1,
            max_canary_percent=15,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-violet-59",
        primary_service="notification-hub",
        alert_channel="#fleet-island-delivery",
        expected_monthly_releases=38,
    ),
    TenantFixture(
        policy=TenantPolicy(
            tenant_id="jetstream-video",
            display_name="Jetstream Video",
            tier=TenantTier.STARTER,
            allowed_regions=("ap-northeast-1", "us-east-1"),
            production_approvers=1,
            max_canary_percent=20,
            minimum_slo_target=99.5,
            freeze_windows_utc=(),
        ),
        owner="team-teal-60",
        primary_service="edge-config",
        alert_channel="#fleet-jetstream-video",
        expected_monthly_releases=41,
    ),
)

ROLLOUT_FIXTURES: tuple[RolloutFixture, ...] = (
    RolloutFixture(
        name="atlas-retail-checkout-api-01",
        tenant_id="atlas-retail",
        service="checkout-api",
        environment=Environment.STAGING,
        regions=("us-east-1", "us-west-2"),
        canary_percent=5,
        availability=99.95,
        latency_p95_ms=170.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="boreal-bank-policy-engine-02",
        tenant_id="boreal-bank",
        service="policy-engine",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=10,
        availability=99.96,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="cinder-media-billing-worker-03",
        tenant_id="cinder-media",
        service="billing-worker",
        environment=Environment.PRODUCTION,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=15,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="delta-health-edge-config-04",
        tenant_id="delta-health",
        service="edge-config",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="ember-logistics-event-router-05",
        tenant_id="ember-logistics",
        service="event-router",
        environment=Environment.STAGING,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=5,
        availability=99.96,
        latency_p95_ms=230.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="fjord-energy-media-transcoder-06",
        tenant_id="fjord-energy",
        service="media-transcoder",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="grove-learning-notification-hub-07",
        tenant_id="grove-learning",
        service="notification-hub",
        environment=Environment.PRODUCTION,
        regions=("us-east-1", "us-west-2"),
        canary_percent=15,
        availability=99.95,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="harbor-travel-identity-gateway-08",
        tenant_id="harbor-travel",
        service="identity-gateway",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=20,
        availability=99.96,
        latency_p95_ms=200.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="indigo-labs-catalog-read-09",
        tenant_id="indigo-labs",
        service="catalog-read",
        environment=Environment.STAGING,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=5,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="juniper-pay-search-indexer-10",
        tenant_id="juniper-pay",
        service="search-indexer",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="keystone-cloud-checkout-api-11",
        tenant_id="keystone-cloud",
        service="checkout-api",
        environment=Environment.PRODUCTION,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=15,
        availability=99.96,
        latency_p95_ms=170.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="lattice-games-policy-engine-12",
        tenant_id="lattice-games",
        service="policy-engine",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="meridian-food-billing-worker-13",
        tenant_id="meridian-food",
        service="billing-worker",
        environment=Environment.STAGING,
        regions=("us-east-1", "us-west-2"),
        canary_percent=5,
        availability=99.95,
        latency_p95_ms=200.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="northstar-auto-edge-config-14",
        tenant_id="northstar-auto",
        service="edge-config",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=10,
        availability=99.96,
        latency_p95_ms=215.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="opal-security-event-router-15",
        tenant_id="opal-security",
        service="event-router",
        environment=Environment.PRODUCTION,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=15,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="prairie-ai-media-transcoder-16",
        tenant_id="prairie-ai",
        service="media-transcoder",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="quartz-robotics-notification-hub-17",
        tenant_id="quartz-robotics",
        service="notification-hub",
        environment=Environment.STAGING,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=5,
        availability=99.96,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="rivet-commerce-identity-gateway-18",
        tenant_id="rivet-commerce",
        service="identity-gateway",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="summit-insurance-catalog-read-19",
        tenant_id="summit-insurance",
        service="catalog-read",
        environment=Environment.PRODUCTION,
        regions=("us-east-1", "us-west-2"),
        canary_percent=15,
        availability=99.95,
        latency_p95_ms=215.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="tundra-mobile-search-indexer-20",
        tenant_id="tundra-mobile",
        service="search-indexer",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=20,
        availability=99.96,
        latency_p95_ms=230.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="uplink-data-checkout-api-21",
        tenant_id="uplink-data",
        service="checkout-api",
        environment=Environment.STAGING,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=5,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="valley-homes-policy-engine-22",
        tenant_id="valley-homes",
        service="policy-engine",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="willow-social-billing-worker-23",
        tenant_id="willow-social",
        service="billing-worker",
        environment=Environment.PRODUCTION,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=15,
        availability=99.96,
        latency_p95_ms=200.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="xenon-biotech-edge-config-24",
        tenant_id="xenon-biotech",
        service="edge-config",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="yonder-maps-event-router-25",
        tenant_id="yonder-maps",
        service="event-router",
        environment=Environment.STAGING,
        regions=("us-east-1", "us-west-2"),
        canary_percent=5,
        availability=99.95,
        latency_p95_ms=230.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="zenith-stream-media-transcoder-26",
        tenant_id="zenith-stream",
        service="media-transcoder",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=10,
        availability=99.96,
        latency_p95_ms=170.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="aurora-civic-notification-hub-27",
        tenant_id="aurora-civic",
        service="notification-hub",
        environment=Environment.PRODUCTION,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=15,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="bramble-books-identity-gateway-28",
        tenant_id="bramble-books",
        service="identity-gateway",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="coral-design-catalog-read-29",
        tenant_id="coral-design",
        service="catalog-read",
        environment=Environment.STAGING,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=5,
        availability=99.96,
        latency_p95_ms=215.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="drift-finance-search-indexer-30",
        tenant_id="drift-finance",
        service="search-indexer",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="elm-mobility-checkout-api-31",
        tenant_id="elm-mobility",
        service="checkout-api",
        environment=Environment.PRODUCTION,
        regions=("us-east-1", "us-west-2"),
        canary_percent=15,
        availability=99.95,
        latency_p95_ms=170.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="forge-analytics-policy-engine-32",
        tenant_id="forge-analytics",
        service="policy-engine",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=20,
        availability=99.96,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="glacier-storage-billing-worker-33",
        tenant_id="glacier-storage",
        service="billing-worker",
        environment=Environment.STAGING,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=5,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="hearth-market-edge-config-34",
        tenant_id="hearth-market",
        service="edge-config",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="ion-weather-event-router-35",
        tenant_id="ion-weather",
        service="event-router",
        environment=Environment.PRODUCTION,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=15,
        availability=99.96,
        latency_p95_ms=230.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="jade-identity-media-transcoder-36",
        tenant_id="jade-identity",
        service="media-transcoder",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="kestrel-devtools-notification-hub-37",
        tenant_id="kestrel-devtools",
        service="notification-hub",
        environment=Environment.STAGING,
        regions=("us-east-1", "us-west-2"),
        canary_percent=5,
        availability=99.95,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="lagoon-supply-identity-gateway-38",
        tenant_id="lagoon-supply",
        service="identity-gateway",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=10,
        availability=99.96,
        latency_p95_ms=200.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="meadow-voice-catalog-read-39",
        tenant_id="meadow-voice",
        service="catalog-read",
        environment=Environment.PRODUCTION,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=15,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="nova-search-search-indexer-40",
        tenant_id="nova-search",
        service="search-indexer",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="orbit-photos-checkout-api-41",
        tenant_id="orbit-photos",
        service="checkout-api",
        environment=Environment.STAGING,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=5,
        availability=99.96,
        latency_p95_ms=170.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="pine-observability-policy-engine-42",
        tenant_id="pine-observability",
        service="policy-engine",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="quiver-support-billing-worker-43",
        tenant_id="quiver-support",
        service="billing-worker",
        environment=Environment.PRODUCTION,
        regions=("us-east-1", "us-west-2"),
        canary_percent=15,
        availability=99.95,
        latency_p95_ms=200.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="ridge-network-edge-config-44",
        tenant_id="ridge-network",
        service="edge-config",
        environment=Environment.PRODUCTION,
        regions=("us-west-2", "eu-west-1"),
        canary_percent=20,
        availability=99.96,
        latency_p95_ms=215.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="spruce-workflows-event-router-45",
        tenant_id="spruce-workflows",
        service="event-router",
        environment=Environment.STAGING,
        regions=("eu-west-1", "eu-central-1"),
        canary_percent=5,
        availability=99.82,
        latency_p95_ms=410.0,
        expected_action="pause",
    ),
    RolloutFixture(
        name="terra-catalog-media-transcoder-46",
        tenant_id="terra-catalog",
        service="media-transcoder",
        environment=Environment.PRODUCTION,
        regions=("eu-central-1", "ap-southeast-1"),
        canary_percent=10,
        availability=98.90,
        latency_p95_ms=770.0,
        expected_action="rollback",
    ),
    RolloutFixture(
        name="umber-compute-notification-hub-47",
        tenant_id="umber-compute",
        service="notification-hub",
        environment=Environment.PRODUCTION,
        regions=("ap-southeast-1", "ap-northeast-1"),
        canary_percent=15,
        availability=99.96,
        latency_p95_ms=185.0,
        expected_action="promote",
    ),
    RolloutFixture(
        name="vista-collaboration-identity-gateway-48",
        tenant_id="vista-collaboration",
        service="identity-gateway",
        environment=Environment.PRODUCTION,
        regions=("ap-northeast-1", "us-east-1"),
        canary_percent=20,
        availability=99.30,
        latency_p95_ms=850.0,
        expected_action="rollback",
    ),
)

def build_fixture_metrics(
    fixture: RolloutFixture,
    sampled_at: datetime = FIXTURE_BASE_TIME,
) -> tuple[MetricSnapshot, ...]:
    request_count = 100_000
    error_count = round(request_count * (100.0 - fixture.availability) / 100.0)
    return tuple(
        MetricSnapshot(
            service=fixture.service,
            environment=fixture.environment,
            region=region,
            sampled_at=sampled_at,
            request_count=request_count,
            error_count=error_count,
            latency_p95_ms=fixture.latency_p95_ms,
        )
        for region in fixture.regions
    )


def fixture_artifact(index: int = 1) -> Artifact:
    return Artifact(
        digest=f"sha256:{index:064x}",
        version=f"2.{index % 20}.{index % 11}",
        source_revision=f"{index:040x}",
        created_at=FIXTURE_BASE_TIME - timedelta(minutes=index),
        sbom_reference=f"sbom://kiron/release-{index:03d}",
    )


def build_control_plane(
    metrics: Iterable[MetricSnapshot],
) -> tuple[
    ReleasePlanner,
    RolloutOrchestrator,
    FeatureFlagService,
    FrozenClock,
    InMemoryDeploymentRepository,
    RecordingRuntimeAdapter,
    InMemoryAuditRepository,
    RecordingNotificationAdapter,
    CounterRegistry,
]:
    clock = FrozenClock(FIXTURE_BASE_TIME)
    tenant_repository = InMemoryTenantRepository(
        fixture.policy for fixture in TENANT_FIXTURES
    )
    deployment_repository = InMemoryDeploymentRepository()
    flag_repository = InMemoryFlagRepository(
        (
            FeatureFlag(
                key="progressive-checkout",
                tenant_id=TENANT_FIXTURES[0].policy.tenant_id,
                kind=FlagKind.BOOLEAN,
                enabled=True,
                default_value=False,
                rules=(
                    FlagRule(
                        id="enterprise-us-canary",
                        description="Enable for enterprise subjects in the first region",
                        percentage=10,
                        regions=("us-east-1",),
                        tenant_tiers=(TenantTier.ENTERPRISE,),
                    ),
                ),
                version=1,
                updated_at=clock.now(),
            ),
        )
    )
    audit_repository = InMemoryAuditRepository()
    alert_repository = InMemoryAlertRepository()
    runtime = RecordingRuntimeAdapter()
    notifications = RecordingNotificationAdapter()
    metric_adapter = FixtureMetricsAdapter(metrics)
    counters = CounterRegistry()
    audit = AuditService(audit_repository, clock)
    slo = SLOService(metric_adapter, clock)
    alerts = AlertService(
        alert_repository,
        notifications,
        audit,
        clock,
    )
    traces = TraceCollector(clock)
    planner = ReleasePlanner(tenant_repository, clock)
    orchestrator = RolloutOrchestrator(
        deployment_repository,
        runtime,
        slo,
        alerts,
        audit,
        traces,
        counters,
        clock,
    )
    flags = FeatureFlagService(flag_repository, audit, clock)
    return (
        planner,
        orchestrator,
        flags,
        clock,
        deployment_repository,
        runtime,
        audit_repository,
        notifications,
        counters,
    )


def assert_raises(
    expected_type: type[BaseException],
    callback: Callable[[], object],
) -> BaseException:
    try:
        callback()
    except expected_type as error:
        return error
    except BaseException as error:
        raise AssertionError(
            f"expected {expected_type.__name__}, got {type(error).__name__}"
        ) from error
    raise AssertionError(f"expected {expected_type.__name__} to be raised")


def test_untyped_stream_token_fixture() -> None:
    stream = StringIO("42 7\n")
    assert read_case(stream) == ["42", "7"]


def test_typed_stream_token_fixture() -> None:
    stream: TextIO = StringIO("release promote\n")
    assert read_typed_case(stream) == ["release", "promote"]


def test_tenant_policy_rejects_unknown_region() -> None:
    fixture = ROLLOUT_FIXTURES[0]
    planner, *_ = build_control_plane(build_fixture_metrics(fixture))
    request = ReleaseRequest(
        tenant_id=fixture.tenant_id,
        service=fixture.service,
        environment=Environment.STAGING,
        regions=("moon-1",),
        artifact=fixture_artifact(),
        requested_by="engineer@kiron.dev",
        approvers=("reviewer@kiron.dev",),
    )
    error = assert_raises(
        PolicyViolationError,
        lambda: planner.create(request),
    )
    assert isinstance(error, PolicyViolationError)
    assert error.details["regions"] == ["moon-1"]


def test_feature_flag_is_deterministic() -> None:
    metrics = build_fixture_metrics(ROLLOUT_FIXTURES[0])
    _, _, flags, *_ = build_control_plane(metrics)
    context = FlagContext(
        subject_id="account-1042",
        region="us-east-1",
        tenant_tier=TenantTier.ENTERPRISE,
        attributes={"plan": "annual"},
    )
    first = flags.evaluate("atlas-retail", "progressive-checkout", context)
    second = flags.evaluate("atlas-retail", "progressive-checkout", context)
    assert first == second


def test_release_starts_at_canary() -> None:
    fixture = ROLLOUT_FIXTURES[1]
    metrics = build_fixture_metrics(fixture)
    (
        planner,
        orchestrator,
        _,
        _,
        deployments,
        runtime,
        audit,
        _,
        counters,
    ) = build_control_plane(metrics)
    policy = next(
        item.policy for item in TENANT_FIXTURES
        if item.policy.tenant_id == fixture.tenant_id
    )
    request = ReleaseRequest(
        tenant_id=fixture.tenant_id,
        service=fixture.service,
        environment=Environment.STAGING,
        regions=policy.allowed_regions[:2],
        artifact=fixture_artifact(2),
        requested_by="release-bot@kiron.dev",
        approvers=("reviewer@kiron.dev",),
        canary_percent=min(5, policy.max_canary_percent),
    )
    plan = planner.create(request)
    deployment = orchestrator.start(
        plan,
        baseline_version="2.0.0",
        correlation_id="corr-start-canary",
    )
    assert deployment.state is ReleaseState.RUNNING
    assert deployment.current_stage.kind is StageKind.CANARY
    assert runtime.deployments[-1][1] == "canary"
    assert deployments.get(deployment.id).revision == 1
    assert audit.query(fixture.tenant_id)[0].action is AuditAction.RELEASE_STARTED
    assert counters.value(
        "fleet_release_total",
        outcome="started",
        environment=Environment.STAGING.value,
    ) == 1


def test_failed_slo_opens_deduplicated_alert() -> None:
    fixture = next(
        item for item in ROLLOUT_FIXTURES
        if item.expected_action == "rollback"
    )
    metrics = build_fixture_metrics(fixture)
    (
        planner,
        orchestrator,
        _,
        _,
        _,
        _,
        audit,
        notifications,
        _,
    ) = build_control_plane(metrics)
    policy = next(
        item.policy for item in TENANT_FIXTURES
        if item.policy.tenant_id == fixture.tenant_id
    )
    request = ReleaseRequest(
        tenant_id=fixture.tenant_id,
        service=fixture.service,
        environment=Environment.STAGING,
        regions=policy.allowed_regions[:2],
        artifact=fixture_artifact(3),
        requested_by="release-bot@kiron.dev",
        approvers=("reviewer@kiron.dev",),
        canary_percent=min(5, policy.max_canary_percent),
    )
    deployment = orchestrator.start(
        planner.create(request),
        baseline_version="1.9.8",
        correlation_id="corr-unhealthy-start",
    )
    definition = SLODefinition(
        service=fixture.service,
        environment=Environment.STAGING,
        availability_target=99.9,
        latency_p95_ms=300,
        window=timedelta(hours=1),
    )
    assert_raises(
        PolicyViolationError,
        lambda: orchestrator.promote(
            deployment.id,
            "operator@kiron.dev",
            definition,
            "corr-unhealthy-promote",
        ),
    )
    assert len(notifications.messages) == 1
    opened = audit.query(
        fixture.tenant_id,
        action=AuditAction.ALERT_OPENED,
    )
    assert len(opened) == 1


def test_rollback_records_baseline_and_audit() -> None:
    fixture = ROLLOUT_FIXTURES[2]
    metrics = build_fixture_metrics(fixture)
    (
        planner,
        orchestrator,
        _,
        _,
        deployments,
        runtime,
        audit,
        _,
        counters,
    ) = build_control_plane(metrics)
    policy = next(
        item.policy for item in TENANT_FIXTURES
        if item.policy.tenant_id == fixture.tenant_id
    )
    request = ReleaseRequest(
        tenant_id=fixture.tenant_id,
        service=fixture.service,
        environment=Environment.STAGING,
        regions=policy.allowed_regions[:2],
        artifact=fixture_artifact(4),
        requested_by="release-bot@kiron.dev",
        approvers=("reviewer@kiron.dev",),
        canary_percent=min(5, policy.max_canary_percent),
    )
    deployment = orchestrator.start(
        planner.create(request),
        baseline_version="2.3.4",
        correlation_id="corr-rollback-start",
    )
    completed = orchestrator.rollback(
        deployment.id,
        "incident-commander@kiron.dev",
        "elevated checkout failures",
        "corr-rollback-finish",
    )
    assert completed.state is ReleaseState.ROLLED_BACK
    assert runtime.rollbacks == [(deployment.id, "2.3.4")]
    assert deployments.get(deployment.id).rollback_reason
    assert audit.query(
        fixture.tenant_id,
        action=AuditAction.RELEASE_ROLLED_BACK,
    )
    assert counters.value(
        "fleet_release_total",
        outcome="rolled_back",
        environment=Environment.STAGING.value,
    ) == 1


def test_optimistic_concurrency_conflict() -> None:
    repository = InMemoryDeploymentRepository()
    fixture = ROLLOUT_FIXTURES[0]
    policy = TENANT_FIXTURES[0].policy
    plan = ReleasePlan(
        id="plan-concurrency",
        tenant_id=policy.tenant_id,
        target=ServiceTarget(
            fixture.service,
            Environment.STAGING,
            policy.allowed_regions[:1],
            2,
        ),
        artifact=fixture_artifact(5),
        stages=(
            RolloutStage(
                "global",
                StageKind.GLOBAL,
                100,
                policy.allowed_regions[:1],
                timedelta(minutes=5),
                1,
            ),
        ),
        created_by="test@kiron.dev",
        created_at=FIXTURE_BASE_TIME,
    )
    original = repository.save(
        Deployment(
            id="deployment-concurrency",
            plan=plan,
            state=ReleaseState.READY,
            current_stage_index=0,
        ),
        expected_revision=0,
    )
    repository.save(
        replace(original, state=ReleaseState.RUNNING),
        expected_revision=original.revision,
    )
    assert_raises(
        ConflictError,
        lambda: repository.save(
            replace(original, state=ReleaseState.PAUSED),
            expected_revision=original.revision,
        ),
    )


def iter_rollout_expectations() -> Iterator[tuple[str, str]]:
    for fixture in ROLLOUT_FIXTURES:
        yield fixture.name, fixture.expected_action


def run_unit_fixtures() -> tuple[str, ...]:
    tests = (
        test_untyped_stream_token_fixture,
        test_typed_stream_token_fixture,
        test_tenant_policy_rejects_unknown_region,
        test_feature_flag_is_deterministic,
        test_release_starts_at_canary,
        test_failed_slo_opens_deduplicated_alert,
        test_rollback_records_baseline_and_audit,
        test_optimistic_concurrency_conflict,
    )
    completed = []
    for test in tests:
        test()
        completed.append(test.__name__)
    return tuple(completed)


def describe_fixture_catalog() -> str:
    action_counts: defaultdict[str, int] = defaultdict(int)
    for fixture in ROLLOUT_FIXTURES:
        action_counts[fixture.expected_action] += 1
    lines = [
        "Kiron Fleet Control Plane",
        f"tenants={len(TENANT_FIXTURES)}",
        f"rollouts={len(ROLLOUT_FIXTURES)}",
        *(
            f"{action}={count}"
            for action, count in sorted(action_counts.items())
        ),
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    completed_tests = run_unit_fixtures()
    print(describe_fixture_catalog())
    print(f"tests={len(completed_tests)}")
